#!/usr/bin/env node
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
 * Usage (run from the project you want synced — --root defaults to cwd):
 *   npx sn-scriptsync-agent [options]
 *   node out/standaloneAgentServer.js [options]
 *
 * Options (all also settable via env var):
 *   --root <path>        (SN_AGENT_ROOT, default: current directory) sync
 *                         folder — the one containing <instance>/ subfolders
 *                         with _settings.json. Defaults to cwd so this can
 *                         run as a project-local devDependency: install it in
 *                         a project, run it from that project's root, and
 *                         everything (instance folders, .sn-scriptsync/) lands
 *                         right there — no path to hunt down or pass in.
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
import { addInstance, getRegistryPath } from './agent/registry';
import { ExtensionUtils } from './ExtensionUtils';

const eu = new ExtensionUtils();

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

// Column widths, so direction / subject / detail line up down the page and the
// eye can scan one column instead of re-parsing every line. Padding is applied
// to the *plain* text before painting — ANSI escapes would otherwise count
// toward the width and break the alignment.
const W_DIR = 6;
const W_SUBJECT = 20;
function pad(text: string, width: number): string {
	return text.length >= width ? text : text + ' '.repeat(width - text.length);
}
function truncate(text: any, max: number): string {
	const s = String(text ?? '');
	return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
function ms(duration: number): string {
	return duration < 1000 ? `${duration}ms` : `${(duration / 1000).toFixed(1)}s`;
}

// Correlation tags. Full ids look like
//   agent_http_1786670786096_a9b6c1_1786670788998_15
// — 50 characters of timestamp noise that wrap the line and bury the one part
// worth reading. The HTTP request's random suffix plus the per-request
// sequence number (`a9b6c1·15`) is enough to tie a WS leg to its HTTP line.
function shortHttpId(id: any): string {
	const parts = String(id ?? '').split('_');
	return parts[parts.length - 1] || String(id ?? '?');
}
function shortRid(rid: any): string {
	const m = /^agent_(.+)_(\d+)_(\d+)$/.exec(String(rid ?? ''));
	return m ? `${shortHttpId(m[1])}·${m[3]}` : shortHttpId(rid);
}

// The point of the whole exercise: say what a message is actually asking for.
// "agentQueryRecords" repeated 28 times is noise; "sys_ux_event limit=200" ×28
// is a picture of what the command is doing.
function describeWsRequest(p: any): string {
	switch (p?.action) {
		case 'agentQueryRecords': {
			const q = new URLSearchParams(String(p.queryString || ''));
			const bits = [p.tableName || '?'];
			const limit = q.get('sysparm_limit');
			const offset = q.get('sysparm_offset');
			if (limit) bits.push(`limit=${limit}`);
			if (offset && offset !== '0') bits.push(`offset=${offset}`);
			const encoded = q.get('sysparm_query');
			if (encoded) bits.push(paint(ANSI.dim, truncate(encoded, 64)));
			return bits.join('  ');
		}
		case 'agentRestApi': {
			const qp = p.queryParams && typeof p.queryParams === 'object'
				? Object.entries(p.queryParams).map(([k, v]) => `${k}=${truncate(v, 30)}`).join('&')
				: '';
			return `${p.method || 'GET'} ${p.endpoint || '?'}${qp ? paint(ANSI.dim, `?${truncate(qp, 70)}`) : ''}`;
		}
		case 'agentRunBackgroundScript':
			return paint(ANSI.dim, `${String(p.script || '').length} chars of script`);
		case 'createRecord':
		case 'requestTableStructure':
		case 'checkNameExists':
			return String(p.tableName || p.table || '');
		case 'agentCodeSearch':
			return truncate(p.term || p.searchTerm || '', 60);
		case 'takeScreenshot':
		case 'activateTab':
		case 'refreshPreview':
			return truncate(p.url || '', 70);
		default:
			return '';
	}
}

function rowCount(n: number): string {
	return `${n} row${n === 1 ? '' : 's'}`;
}

function describeWsResponse(p: any): string {
	if (Array.isArray(p?.records)) return rowCount(p.records.length);
	const inner = p?.data?.result;
	if (Array.isArray(inner)) return rowCount(inner.length);
	if (inner && typeof inner === 'object') return '1 record';
	if (p?.success === false || p?.error) return paint(ANSI.red, truncate(p.error || 'error', 70));
	if (typeof p?.status === 'number') return `HTTP ${p.status}`;
	return '';
}

// The bare identifying token for a request, with NO colour applied — the
// response line re-prints it, and truncating a painted string can slice an
// ANSI escape in half and corrupt the rest of the line.
function wsSubject(p: any): string {
	switch (p?.action) {
		case 'agentQueryRecords': return String(p.tableName || '');
		case 'agentRestApi': return `${p.method || 'GET'} ${p.endpoint || ''}`;
		case 'createRecord':
		case 'requestTableStructure':
		case 'checkNameExists': return String(p.tableName || p.table || '');
		default: return '';
	}
}

// WS legs awaiting a response, so the response line can report elapsed time and
// repeat the subject (which table) instead of making you scroll up to the
// matching request. Bounded: a browser that never answers must not leak.
const MAX_IN_FLIGHT = 500;
const inFlightWs = new Map<string, { at: number; subject: string }>();

function logHttpTraffic(event: TrafficEvent) {
	if (event.type === 'request') {
		const params = event.params && typeof event.params === 'object'
			? Object.entries(event.params)
				.filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v))
				.slice(0, 4)
				.map(([k, v]) => `${k}=${truncate(v, 40)}`)
				.join(' ')
			: '';
		const subject = [event.instance, params].filter(Boolean).join('  ');
		console.log(
			`${timestamp()} ${paint(ANSI.cyan + ANSI.bold, pad('→ HTTP', W_DIR))}  ` +
			`${paint(ANSI.bold, pad(event.command, W_SUBJECT))}  ${subject}  ` +
			`${paint(ANSI.dim, `#${shortHttpId(event.id)}`)}`,
		);
	} else if (event.type === 'response') {
		const ok = event.status === 'success';
		const outcome = ok ? paint(ANSI.green, 'ok') : paint(ANSI.red, event.code || 'error');
		const detail = [event.summary, ms(event.durationMs)].filter(Boolean).join('  ');
		console.log(
			`${timestamp()} ${paint((ok ? ANSI.green : ANSI.red) + ANSI.bold, pad('← HTTP', W_DIR))}  ` +
			`${paint(ANSI.bold, pad(event.command, W_SUBJECT))}  ${outcome}  ${detail}  ` +
			`${paint(ANSI.dim, `#${shortHttpId(event.id)}`)}`,
		);
	} else {
		console.log(`${timestamp()} ${paint(ANSI.yellow, pad('✕ HTTP', W_DIR))}  401 unauthorized  ${event.path}`);
	}
}

function logWsTraffic(direction: '→' | '←', payload: any, extra?: string) {
	const action = String(payload?.action || '(no action)').replace(/^agent/, '');
	const rid = payload?.agentRequestId;
	const color = direction === '→' ? ANSI.cyan : ANSI.magenta;

	let detail: string;
	if (direction === '→') {
		detail = describeWsRequest(payload);
		if (rid) {
			if (inFlightWs.size >= MAX_IN_FLIGHT) inFlightWs.clear();
			inFlightWs.set(rid, { at: Date.now(), subject: truncate(wsSubject(payload), 44) });
		}
	} else {
		detail = describeWsResponse(payload);
		const started = rid ? inFlightWs.get(rid) : undefined;
		if (started) {
			inFlightWs.delete(rid);
			// echo the subject so the response stands alone, and time the leg
			detail = [started.subject, detail, paint(ANSI.dim, ms(Date.now() - started.at))]
				.filter(Boolean).join('  ');
		}
	}

	// Fixed prefix keeps the ws lines in the same columns as the HTTP ones; only
	// the optional trailing parts are collapsed, so an absent detail or rid
	// doesn't leave a double gap.
	const head = `${timestamp()} ${paint(color, pad(`  ${direction} ws`, W_DIR))}  ${pad(action, W_SUBJECT)}`;
	const tail = [
		detail,
		rid ? paint(ANSI.dim, `#${shortRid(rid)}`) : '',
		extra ? paint(ANSI.yellow, extra) : '',
	].filter(Boolean).join('  ');
	console.log(tail ? `${head}  ${tail}` : head);
}

interface CliOptions {
	root: string;
	rootExplicit: boolean;
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

	const rootExplicit = !!root;
	// Default to cwd — the point of running this as a project-local
	// devDependency is "install here, run here", not "figure out and pass
	// in a path every time".
	if (!root) root = process.cwd();

	return { root, rootExplicit, wsPort, configPath };
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
	// Same timestamp + direction columns as the traffic lines, so command
	// progress (`refresh_scope: 994 record(s) ...`) reads inline with the wire
	// traffic that produced it instead of as a differently-shaped aside.
	const log = (msg: string) => console.log(`${timestamp()} ${paint(ANSI.dim, pad('·', W_DIR))}  ${msg}`);

	if (!opts.rootExplicit) {
		log(`No --root given — using the current directory: ${opts.root}`);
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

	// Ask the browser to hand over a fresh session token for every instance we
	// know about.
	//
	// `_settings.json`'s g_ck only refreshes when the helper tab relays a message
	// carrying that instance, and merely *connecting* doesn't do it (the tab
	// opens with helperBuildInfo/helperLicenseInfo and nothing else). So a
	// server restarted after the browser session aged out starts life holding a
	// token ServiceNow will reject, and the first command to need it fails —
	// previously as a silent empty result, now as E_TOKEN_EXPIRED. Running
	// /token is exactly the trigger that makes the tab relay a new one, and it's
	// a browser-extension action, so it works even though ServiceNow itself is
	// rejecting us.
	//
	// Fire-and-forget on purpose: the token arrives later as its own `instance`
	// message, not as a reply to this, so there's no correlation id to wait on.
	// Once per connection, not per message.
	let tokenRefreshRequested = false;
	function requestTokenRefresh() {
		if (tokenRefreshRequested) return;
		tokenRefreshRequested = true;

		let instances: Array<{ name: string; url: string }> = [];
		try {
			instances = fs.readdirSync(root, { withFileTypes: true })
				.filter((d) => d.isDirectory() && !d.name.startsWith('.'))
				.map((d) => {
					const settings = eu.getFileAsJson(path.join(root, d.name, '_settings.json'));
					return settings?.url ? { name: d.name, url: String(settings.url) } : undefined;
				})
				.filter((i): i is { name: string; url: string } => !!i);
		} catch { /* no readable instance folders — nothing to refresh */ }

		if (!instances.length) {
			log('No instance folders with _settings.json yet — skipping token refresh');
			return;
		}

		// Let the tab finish its own handshake before we ask it for anything.
		setTimeout(() => {
			for (const inst of instances) {
				log(`Requesting a fresh session token for ${inst.name} (/token)`);
				broadcastToHelperTab({
					action: 'runSlashCommand',
					command: '/token',
					url: `${inst.url.replace(/\/+$/, '')}/*`,
					autoRun: true,
				});
			}
		}, 750);
	}

	wss.on('connection', (ws: any) => {
		console.log(`${timestamp()} ${paint(ANSI.bold + ANSI.magenta, '● Helper tab connected')}`);
		requestTokenRefresh();
		ws.on('close', () => console.log(`${timestamp()} ${paint(ANSI.magenta, '○ Helper tab disconnected')}`));
		ws.on('error', (err: any) => log(`Helper tab socket error: ${err?.message || err}`));
		ws.on('message', (raw: any) => {
			let messageJson: any;
			try {
				messageJson = JSON.parse(raw.toString());
			} catch {
				return;
			}

			// Mirrors extension.ts's unconditional `if (messageJson?.instance)
			// eu.writeInstanceSettings(...)` — without this, _settings.json (and
			// its g_ck) never refreshes headless, and a brand-new instance can
			// never bootstrap here at all. Detect "new" *before* writing so the
			// registry only gets touched when it would otherwise go stale, not
			// on every message (these arrive far too often for that to be cheap).
			if (messageJson?.instance) {
				const isNewInstance = !!messageJson.instance.name
					&& !fs.existsSync(path.join(root, messageJson.instance.name));
				eu.writeInstanceSettings(messageJson.instance);
				if (isNewInstance) {
					addInstance(root, process.pid, { name: messageJson.instance.name, url: messageJson.instance.url });
					log(`New instance discovered: ${messageJson.instance.name}`);
				}
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
			getBridgeStatus: () => ({ serverRunning, browserConnected: !!wss && wss.clients.size > 0 }),
			wsPort: opts.wsPort,
		});
	} catch (e: any) {
		log(`Agent HTTP API failed to start: ${e?.message || e}`);
		process.exit(1);
		return;
	}

	log(`Agent HTTP API listening on 127.0.0.1:${httpState.port}`);
	log(`Port/token file: ${httpState.portFilePath || '(not written — could not resolve root)'}`);
	log(`Sync folder: ${root}`);
	log(`Registered in: ${getRegistryPath()}`);

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
