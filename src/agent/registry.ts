// Global, per-machine registry of running sn-scriptsync agent servers (both
// the standalone host and the VS Code extension), so an agent that only
// knows "which instance" doesn't also need to already know "which root
// folder" to find the right server. Lives outside any sync folder, at
// ~/.sn-scriptsync/servers.json — filesystem-only, no network exposure (see
// the mDNS/Bonjour discussion this was chosen over).
//
// Deliberately does NOT carry the X-Agent-Token: this file only points at
// portFilePath, where the real per-root port+token file lives (still subject
// to the same pid/health-check verification agents already do before
// trusting it). Keeping the secret scoped to one file per root, rather than
// duplicated into a global index, keeps the blast radius of a leaked
// registry file to "which servers exist", not "how to call them".

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { listInstanceFolders } from './instanceResolver';
import { ExtensionUtils } from '../ExtensionUtils';

const eu = new ExtensionUtils();

const REGISTRY_DIR = path.join(os.homedir(), '.sn-scriptsync');
const REGISTRY_FILE = path.join(REGISTRY_DIR, 'servers.json');

export interface RegistryInstance {
	name: string;
	url?: string;
}

export interface RegistryEntry {
	root: string;
	pid: number;
	httpPort: number;
	wsPort: number;
	portFilePath?: string;
	instances: RegistryInstance[];
	startedAt: number;
}

export function getRegistryPath(): string {
	return REGISTRY_FILE;
}

/** Every instance folder currently known under the active workspace root. */
export function collectInstances(): RegistryInstance[] {
	return listInstanceFolders().map((folder) => {
		const name = path.basename(folder);
		const settings = eu.getInstanceSettings(name);
		return { name, url: settings && settings.url };
	});
}

function isPidAlive(pid: number): boolean {
	try {
		// Signal 0 checks existence/permission without actually sending a signal.
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readRegistry(): RegistryEntry[] {
	try {
		const parsed = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function writeRegistry(entries: RegistryEntry[]): void {
	try {
		fs.mkdirSync(REGISTRY_DIR, { recursive: true });
		fs.writeFileSync(REGISTRY_FILE, JSON.stringify(entries, null, 2));
	} catch {
		// Best-effort — the registry is a discovery convenience, not required
		// for the server itself to function; a write failure here shouldn't
		// take down the HTTP/WS server.
	}
}

/**
 * Register this process as a running server. Replaces any existing entry for
 * the same root (a restart supersedes its own prior entry) and prunes any
 * entry whose pid is no longer alive (a crash that skipped unregisterServer).
 */
export function registerServer(entry: Omit<RegistryEntry, 'startedAt'>): void {
	const entries = readRegistry()
		.filter((e) => e.root !== entry.root)
		.filter((e) => isPidAlive(e.pid));
	entries.push({ ...entry, startedAt: Date.now() });
	writeRegistry(entries);
}

/** Remove this process's entry. Called on clean shutdown. */
export function unregisterServer(root: string, pid: number): void {
	writeRegistry(readRegistry().filter((e) => !(e.root === root && e.pid === pid)));
}

/**
 * Refresh the instance list for a running entry from a fresh filesystem scan.
 * Only safe to call when every instance folder it'll see is already fully
 * written — i.e. at registration time, not synchronously after
 * ExtensionUtils.writeInstanceSettings() (which is fire-and-forget: its
 * fs.mkdir/fs.writeFile complete in a later tick, so a scan run immediately
 * after it can race and miss the very folder that just triggered it).
 */
export function updateInstances(root: string, pid: number, instances: RegistryInstance[]): void {
	const entries = readRegistry();
	const entry = entries.find((e) => e.root === root && e.pid === pid);
	if (!entry) return;
	entry.instances = instances;
	writeRegistry(entries);
}

/**
 * Add (or update the url of) a single instance without touching the
 * filesystem — the race-free way to reflect a just-discovered instance
 * before ExtensionUtils.writeInstanceSettings()'s async write has actually
 * landed on disk. Called from the writeInstanceSettings mirror in
 * extension.ts / standaloneAgentServer.ts.
 */
export function addInstance(root: string, pid: number, instance: RegistryInstance): void {
	const entries = readRegistry();
	const entry = entries.find((e) => e.root === root && e.pid === pid);
	if (!entry) return;
	const existing = entry.instances.find((i) => i.name === instance.name);
	if (existing) {
		existing.url = instance.url;
	} else {
		entry.instances.push(instance);
	}
	writeRegistry(entries);
}
