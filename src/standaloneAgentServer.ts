/*
 * Standalone host for the sn-scriptsync HTTP Agent API — no VS Code required.
 *
 * This replaces extension.ts's activate() with the minimum needed to keep the
 * two things that actually matter working: the WebSocket relay to the SN
 * Utils browser helper tab (the "secret sauce" — auth stays in the browser
 * session, this process never touches ServiceNow credentials directly), and
 * the HTTP Agent API that AI agents talk to. Everything VS Code-UI-specific
 * (tree views, editor commands, the Pending Saves review queue, the legacy
 * file-based Agent API transport) is deliberately left out.
 *
 * The agent command layer (src/agent/*) was already decoupled from `vscode`
 * behind the Runtime shim (see src/agent/runtime.ts) — this file is the
 * second implementation of that shim, alongside extension.ts's.
 *
 * Usage:
 *   node out/standaloneAgentServer.js --root /path/to/scriptsync-folder [options]
 *
 * Options (all also settable via env var):
 *   --root <path>        (SN_AGENT_ROOT, required) sync folder — the one
 *                         containing <instance>/ subfolders with _settings.json
 *   --ws-port <n>         (SN_AGENT_WS_PORT, default 1978) port the SN Utils
 *                         helper tab dials. Must be 1978 unless your SN Utils
 *                         build has been configured for a different port.
 *   --config <path>       (SN_AGENT_CONFIG) JSON file of sn-scriptsync
 *                         permission-gate settings, e.g.:
 *                         { "createArtifacts.enabled": true, "restRequest.enabled": false }
 *                         Keys match package.json's contributes.configuration
 *                         ids. Omit entirely to use the same defaults VS Code
 *                         ships with.
 *
 * Only one process can hold the WebSocket port at a time — stop any running
 * VS Code window with the sn-scriptsync extension enabled before starting
 * this, or point --ws-port at a free port and reconfigure the browser side.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as WebSocket from 'ws';

import { setHeadlessWorkspaceRoot } from './workspaceRoot';
import { setRuntime } from './agent/runtime';
import * as pendingRegistry from './agent/pendingRegistry';
import { setHeadlessSettings } from './agent/commands/_shared';
import { startAgentHttpServer, stopAgentHttpServer, HttpServerState, TrafficEvent } from './agent/transport/http';
import { AgentErrorCode } from './agent/errors';

// --- Rich traffic log -------------------------------------------------------
// Colorized, structured lines for every HTTP request/response and every
// WS message to/from the SN Utils helper tab, so `--root ...` run in a
// terminal reads as a live traffic stream. No dependency: plain ANSI codes,
// disabled automatically when not a TTY or when NO_COLOR is set (output
// piped to a file stays plain, per the usual CLI convention).
const useColor = !!process.stdout.isTTY && !process.env.NO_COLOR;
const ANSI = {
	reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
	green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', magenta: '\x1b[35m',
};
function paint(code: string, text: string): string {
	return useColor ? `${code}${text}${ANSI.reset}` : text;
}
function timestamp(): string {
	return paint(ANSI.dim, new Date().toISOString().slice(11, 23));
}

function logHttpTraffic(event: TrafficEvent) {
	if (event.type === 'request') {
		console.log(`${timestamp()} ${paint(ANSI.cyan, '→ HTTP')}  ${event.command}${event.instance ? ` (${event.instance})` : ''}  ${paint(ANSI.dim, `id=${event.id}`)}`);
	} else if (event.type === 'response') {
		const ok = event.status === 'success';
		const arrow = paint(ok ? ANSI.green : ANSI.red, `← HTTP  ${ok ? 'ok ' : (event.code || 'error')}`);
		console.log(`${timestamp()} ${arrow}  ${event.command}  ${paint(ANSI.dim, `id=${event.id}  ${event.durationMs}ms`)}`);
	} else {
		console.log(`${timestamp()} ${paint(ANSI.yellow, '✕ HTTP  401 unauthorized')}  ${event.path}`);
	}
}

function logWsTraffic(direction: '→' | '←', payload: any, extra?: string) {
	const action = payload?.action || '(no action)';
	const color = direction === '→' ? ANSI.cyan : ANSI.magenta;
	const rid = payload?.agentRequestId ? paint(ANSI.dim, `rid=${payload.agentRequestId}`) : '';
	console.log(`${timestamp()} ${paint(color, `${direction} WS   `)} ${action}  ${rid}${extra ? `  ${paint(ANSI.dim, extra)}` : ''}`);
}

interface CliOptions {
	root: string;
	wsPort: number;
	configPath?: string;
}

function parseArgs(argv: string[]): CliOptions {
	let root = process.env.SN_AGENT_ROOT || '';
	let wsPort = Number(process.env.SN_AGENT_WS_PORT) || 1978;
	let configPath = process.env.SN_AGENT_CONFIG || undefined;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--root') root = argv[++i] || root;
		else if (arg === '--ws-port') wsPort = Number(argv[++i]) || wsPort;
		else if (arg === '--config') configPath = argv[++i] || configPath;
	}

	return { root, wsPort, configPath };
}

function loadHeadlessSettings(configPath: string | undefined, log: (msg: string) => void) {
	if (!configPath) return;
	try {
		const raw = fs.readFileSync(configPath, 'utf-8');
		const parsed = JSON.parse(raw);
		setHeadlessSettings(parsed);
		log(`Loaded settings from ${configPath}: ${Object.keys(parsed).join(', ') || '(empty)'}`);
	} catch (e: any) {
		log(`Could not read --config ${configPath}: ${e?.message || e} — using defaults`);
	}
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const log = (msg: string) => console.log(`[sn-agent-server] ${msg}`);

	if (!opts.root) {
		console.error('Usage: node out/standaloneAgentServer.js --root <sync-folder> [--ws-port 1978] [--config settings.json]');
		console.error('(or set SN_AGENT_ROOT / SN_AGENT_WS_PORT / SN_AGENT_CONFIG env vars)');
		process.exit(1);
	}

	const root = path.resolve(opts.root);
	if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
		console.error(`--root does not exist or is not a directory: ${root}`);
		process.exit(1);
	}

	setHeadlessWorkspaceRoot(root);
	loadHeadlessSettings(opts.configPath, log);

	let wss: any;
	let serverRunning = false;

	function broadcastToHelperTab(messageObj: any) {
		if (!wss) return;
		if (typeof messageObj === 'object') {
			messageObj.appName = messageObj.appName || 'sn-scriptsync-standalone-agent-server';
		}
		logWsTraffic('→', messageObj);
		const message = JSON.stringify(messageObj);
		wss.clients.forEach((client: any) => {
			if (client.readyState === WebSocket.OPEN) {
				client.send(message);
			}
		});
	}

	setRuntime({
		sendToBrowser: (payload) => broadcastToHelperTab(payload),
		hasBrowserClient: () => !!wss && wss.clients.size > 0,
		isServerRunning: () => serverRunning,
		log,
		// No review-queue / staged-write UI headless: omit reviewWritesEnabled and
		// stageAgentWrite. The Runtime shim already treats both as optional and
		// falls back to "review off" (buildContext in agent/runtime.ts).
	});

	// --- WebSocket relay: the browser helper tab connects here exactly as it
	// does to the VS Code extension. Only the agentRequestId correlation
	// branch is needed — that's the sole mechanism every Agent API command
	// uses to match a browser response back to its pending HTTP request (see
	// the header comment in src/agent/commands/_shared.ts).
	wss = new (WebSocket as any).Server({ port: opts.wsPort, host: '127.0.0.1' });

	wss.on('listening', () => {
		serverRunning = true;
		log(`WebSocket relay listening on 127.0.0.1:${opts.wsPort} — waiting for the SN Utils helper tab (/token)`);
	});

	wss.on('error', (err: any) => {
		log(`WebSocket server error: ${err?.message || err}`);
		if (err?.code === 'EADDRINUSE') {
			log(`Port ${opts.wsPort} is already in use — is a VS Code window with sn-scriptsync also running? Only one can hold this port.`);
		}
		process.exit(1);
	});

	wss.on('connection', (ws: any) => {
		console.log(`${timestamp()} ${paint(ANSI.bold + ANSI.magenta, '● Helper tab connected')}`);
		ws.on('close', () => console.log(`${timestamp()} ${paint(ANSI.magenta, '○ Helper tab disconnected')}`));
		ws.on('error', (err: any) => log(`Helper tab socket error: ${err?.message || err}`));
		ws.on('message', (raw: any) => {
			let messageJson: any;
			try {
				messageJson = JSON.parse(raw.toString());
			} catch {
				return;
			}
			if (messageJson?.agentRequestId) {
				const matched = pendingRegistry.resolve(messageJson.agentRequestId, messageJson);
				logWsTraffic('←', messageJson, matched ? undefined : 'unmatched — no pending request for this id');
			} else {
				logWsTraffic('←', messageJson);
			}
		});
	});

	// --- HTTP Agent API ---
	let httpState: HttpServerState;
	try {
		httpState = await startAgentHttpServer({
			onLog: (m) => log(`[agent-http] ${m}`),
			onTraffic: logHttpTraffic,
		});
	} catch (e: any) {
		log(`Agent HTTP API failed to start: ${e?.message || e}`);
		process.exit(1);
		return;
	}

	log(`Agent HTTP API listening on 127.0.0.1:${httpState.port}`);
	log(`Port/token file: ${httpState.portFilePath || '(not written — could not resolve root)'}`);
	log(`Sync folder: ${root}`);

	let shuttingDown = false;
	async function shutdown(signal: string) {
		if (shuttingDown) return;
		shuttingDown = true;
		log(`Received ${signal}, shutting down...`);
		serverRunning = false;
		pendingRegistry.rejectAll('E_SERVER_NOT_RUNNING' as AgentErrorCode, 'Server shutting down');
		await stopAgentHttpServer(httpState);
		await new Promise<void>((resolve) => {
			if (!wss) return resolve();
			wss.clients.forEach((c: any) => { try { c.terminate(); } catch { /* ignore */ } });
			wss.close(() => resolve());
		});
		process.exit(0);
	}

	process.on('SIGINT', () => shutdown('SIGINT'));
	process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
	console.error('[sn-agent-server] fatal error:', err?.stack || err);
	process.exit(1);
});
