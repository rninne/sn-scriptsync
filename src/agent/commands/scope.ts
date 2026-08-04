// refresh_scope — reset every locally synced file in a scope back to whatever
// is currently on the instance. Ports the "Load/Refresh artifacts from scope"
// VS Code command (extension.ts's requestScopeArtifacts /
// writeInstanceMetaDataScope / writeTableFields) onto the Agent API's
// request/response model instead of its original fire-and-forget
// actionGoal broadcast + module-global response counter.
//
// Two-stage round trip, same as the original:
//   1. List every sys_metadata record in the scope (which tables/records exist).
//   2. For each table sn-scriptsync tracks a code field on, fetch the real
//      field content and overwrite the local file — concurrently, not
//      sequentially, and correlated per-table instead of via a shared counter
//      so concurrent refreshes of different scopes can't race each other.
//
// Deliberately dropped vs. the original: the in-memory scope.json tree +
// prune pass that feeds the VS Code Scope Tree View. That bookkeeping has no
// reader outside ScopeTreeViewProvider.ts (grep confirms no Agent API command
// or fileNameToObject() touches scope.json), so skipping it headless is safe
// — it just means scope.json won't exist until the folder is opened in VS
// Code and refreshed there once, same as any other fresh sync folder.

import * as fs from 'fs';
import * as path from 'path';
import { CommandHandler, AgentContext } from '../types';
import { AgentError } from '../errors';
import { ExtensionUtils } from '../../ExtensionUtils';
import { Constants } from '../../constants';
import { mustGetInstanceSettings, queryRecords } from './_shared';

const eu = new ExtensionUtils();

interface TableFieldConfig {
	label?: string;
	group?: string;
	codeFields?: Record<string, { label: string; type: string }>;
	referenceFields?: Record<string, { table: string; label: string }>;
}

interface MetaDataRelations {
	tableFields: Record<string, TableFieldConfig>;
}

// Loaded once and never mutated (the original mutated its copy in place to
// filter out non-code tables; here every derived value is computed fresh
// per call instead, so concurrent requests can't step on each other).
let cachedRelations: MetaDataRelations | undefined;
function loadMetaDataRelations(): MetaDataRelations {
	if (!cachedRelations) {
		const p = path.join(__dirname, '..', '..', '..', 'resources', 'metaDataRelations.json');
		cachedRelations = eu.getFileAsJson(p) as MetaDataRelations;
	}
	return cachedRelations;
}

function listScopeFolders(instanceFolder: string): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(instanceFolder, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries.filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
}

function resolveScopeInternalName(instanceFolder: string, scopeName: string): string | undefined {
	if (scopeName === 'global') return 'global';
	const scopes = eu.getFileAsJson(path.join(instanceFolder, 'scopes.json'));
	return scopes[scopeName];
}

// Mirrors writeTableFields()'s extension resolution (extension.ts), minus the
// ecc_agent_script_file rename (that table's per-record filename override
// only ever affected a variable nothing downstream reads — dead in the
// original, so it's not replicated here).
function deriveFileExtension(fieldType: string, fieldName: string): string {
	let ext = (Constants.FIELDTYPES as Record<string, { extension: string }>)[fieldType]?.extension || '.js';
	if (fieldType.includes('xml')) ext = '.xml';
	else if (fieldType.includes('html')) ext = '.html';
	else if (fieldType.includes('json')) ext = '.json';
	else if (fieldType.includes('css') || fieldType === 'properties' || fieldName === 'css') ext = '.scss';
	else if (fieldType.includes('string') || fieldType === 'conditions') ext = '.txt';
	return ext;
}

const TABLE_QUERY_LIMIT = 200;

interface TableRefreshResult {
	table: string;
	records: number;
	filesWritten: number;
	truncated: boolean;
}

async function refreshTable(
	ctx: AgentContext,
	instance: any,
	table: string,
	scope: string,
	tableFolder: string,
	includeEmpty: boolean,
	tableConfig: TableFieldConfig,
): Promise<TableRefreshResult> {
	const codeFields = Object.keys(tableConfig.codeFields || {});
	if (!codeFields.length) {
		return { table, records: 0, filesWritten: 0, truncated: false };
	}

	const queryString =
		`sysparm_fields=sys_name,sys_id,${codeFields.join(',')}` +
		`&sysparm_query=sys_scope=${scope}^sys_class_name=${table}` +
		`&sysparm_exclude_reference_link=true&sysparm_no_count=true&sysparm_limit=${TABLE_QUERY_LIMIT}`;

	const records: any[] = await queryRecords(ctx, instance, table, queryString);
	const truncated = records.length === TABLE_QUERY_LIMIT;

	const isFolderRecordTable = Constants.FOLDERRECORDTABLES.includes(table);
	const separator = isFolderRecordTable ? path.sep : '.';
	const mapFile = path.join(tableFolder, '_map.json');
	const nameToSysId: Record<string, string> = eu.writeOrReadNameToSysIdMapping(mapFile) as Record<string, string>;

	const writes: Promise<void>[] = [];

	for (const record of records) {
		const sysId = String(record.sys_id);
		let cleanName = String(record.sys_name || '').replace(/[^a-z0-9._\-+]+/gi, '').replace(/\./g, '-') || sysId;
		const existingName = Object.keys(nameToSysId).find((n) => nameToSysId[n] === sysId);
		if (existingName) cleanName = existingName;
		if (nameToSysId[cleanName] && nameToSysId[cleanName] !== sysId) {
			cleanName = cleanName + ('-' + sysId.slice(0, 2) + sysId.slice(-2)).toUpperCase();
		}

		if (table === 'sp_widget') {
			const dispVal = String(record.sys_name || '').toLowerCase().replace(/ /g, '_');
			const widgetDir = path.join(tableFolder, cleanName);
			const testUrls = [
				`${instance.url}/$sp.do?id=sp-preview&sys_id=${sysId}`,
				`${instance.url}/sp_config?id=${dispVal}`,
				`${instance.url}/sp?id=${dispVal}`,
				`${instance.url}/esc?id=${dispVal}`,
			];
			eu.writeFileIfNotExists(path.join(widgetDir, '_test_urls.txt'), testUrls.join('\n'), false, () => { /* best effort */ });
		}

		for (const field of codeFields) {
			const fieldType = tableConfig.codeFields![field]?.type || 'script';
			const ext = deriveFileExtension(fieldType, field);
			const fileName = path.join(tableFolder, `${cleanName}${separator}${field}${ext}`);

			let fieldValue: string;
			try {
				fieldValue = record[field] === undefined || record[field] === null ? 'undefined' : String(record[field]);
			} catch {
				fieldValue = 'undefined';
			}

			if ((includeEmpty || isFolderRecordTable || fieldValue !== '') && fieldValue !== 'undefined') {
				nameToSysId[cleanName] = sysId;
				writes.push(new Promise<void>((resolve) => eu.writeFile(fileName, fieldValue, false, () => resolve())));
			}
		}
	}

	if (Object.keys(nameToSysId).length) {
		eu.writeOrReadNameToSysIdMapping(mapFile, nameToSysId);
	}

	await Promise.all(writes);
	return { table, records: records.length, filesWritten: writes.length, truncated };
}

const META_QUERY_LIMIT = 2000;

const refresh_scope: CommandHandler = {
	name: 'refresh_scope',
	requiresBrowser: true,
	docs: {
		summary: 'Reset every locally synced file in a scope back to the instance\'s current values — a drift-guard/reset ritual. Overwrites local files; does not touch the instance.',
		request: { command: 'refresh_scope', id: 'rs_1', params: { scopeName: 'x_app_scope' } },
		response: {
			status: 'success',
			result: {
				scopeName: 'x_app_scope',
				scope: 'x_app_scope',
				tablesRefreshed: 3,
				filesWritten: 12,
				tables: [{ table: 'sys_script_include', records: 4, filesWritten: 4 }],
			},
		},
		notes: 'scopeName is the folder name under the instance (e.g. "global" or your app scope\'s folder). Omit it when the instance has exactly one scope folder — it\'s inferred; otherwise it\'s required. `includeEmpty` (default false) also writes empty code fields, matching the VS Code "include empty" variant of Load/Refresh Scope. Table listing is capped at 2000 records and each table\'s field fetch at 200 records; a `truncatedTables`/`truncated` flag on the response means a scope is larger than that and some files may be missing — re-run is not sufficient, this needs pagination support to fully cover it.',
	},
	async handle(ctx, params) {
		const includeEmpty = !!params?.includeEmpty;
		let scopeName: string | undefined = params?.scopeName;

		if (!scopeName) {
			const folders = listScopeFolders(ctx.instanceFolder);
			if (folders.length === 1) {
				scopeName = folders[0];
			} else if (folders.length === 0) {
				throw new AgentError('E_INVALID_PARAMS', 'No scope folders found under this instance. Pass "scopeName" explicitly (e.g. "global" or your app scope\'s folder name).');
			} else {
				throw new AgentError('E_INVALID_PARAMS', `Multiple scopes found (${folders.join(', ')}). Pass "scopeName" in params to pick one.`);
			}
		}

		const scopeDir = path.join(ctx.instanceFolder, scopeName);
		if (path.relative(ctx.instanceFolder, scopeDir).startsWith('..')) {
			throw new AgentError('E_SECURITY', 'scopeName escapes the instance folder');
		}

		const scope = resolveScopeInternalName(ctx.instanceFolder, scopeName);
		if (!scope) {
			throw new AgentError(
				'E_INSTANCE_NOT_FOUND',
				`Unknown scope "${scopeName}" — no entry in scopes.json. Sync at least one file from this scope via VS Code first, or pass the scope's internal name.`,
			);
		}

		const instance = mustGetInstanceSettings(ctx.instanceFolder);
		const relations = loadMetaDataRelations();

		// Stage 1: what exists in this scope.
		const metaQuery =
			'sysparm_fields=sys_class_name,sys_name,sys_id,sys_updated_on' +
			`&sysparm_query=sys_scope=${scope}^sys_class_name!=sys_metadata_delete^sys_update_name!=NULL^ORDERBYDESCsys_class_name` +
			`&sysparm_no_count=true&sysparm_limit=${META_QUERY_LIMIT}`;
		const metaRecords: any[] = await queryRecords(ctx, instance, 'sys_metadata', metaQuery);
		ctx.log(`refresh_scope: ${metaRecords.length} record(s) in scope "${scopeName}"`);

		const tablesInScope = [...new Set(metaRecords.map((r: any) => String(r.sys_class_name)))];
		const codeTables = tablesInScope.filter((t) => relations.tableFields[t]?.codeFields);

		if (!codeTables.length) {
			return {
				scopeName,
				scope,
				tablesRefreshed: 0,
				filesWritten: 0,
				message: metaRecords.length === META_QUERY_LIMIT
					? `Scope listing hit the ${META_QUERY_LIMIT}-record cap and may be incomplete, but no code-bearing tables were found in what was returned.`
					: 'No code-bearing tables found in this scope — nothing to refresh.',
			};
		}

		// Stage 2: real field content per table, concurrently — no shared
		// counter, so refreshing two scopes at once can't race.
		const results = await Promise.all(codeTables.map((table) =>
			refreshTable(ctx, instance, table, scope!, path.join(scopeDir, table), includeEmpty, relations.tableFields[table]),
		));

		const filesWritten = results.reduce((sum, r) => sum + r.filesWritten, 0);
		const truncatedTables = results.filter((r) => r.truncated).map((r) => r.table);
		if (truncatedTables.length) {
			ctx.log(`refresh_scope: table(s) hit the ${TABLE_QUERY_LIMIT}-record limit, results may be incomplete: ${truncatedTables.join(', ')}`);
		}
		if (metaRecords.length === META_QUERY_LIMIT) {
			ctx.log(`refresh_scope: scope listing hit the ${META_QUERY_LIMIT}-record cap — some tables may be missing entirely.`);
		}

		return {
			scopeName,
			scope,
			tablesRefreshed: results.length,
			filesWritten,
			tables: results.map((r) => ({ table: r.table, records: r.records, filesWritten: r.filesWritten })),
			...(truncatedTables.length ? { truncatedTables } : {}),
			...(metaRecords.length === META_QUERY_LIMIT ? { scopeListingTruncated: true } : {}),
		};
	},
};

export const scopeCommands: CommandHandler[] = [refresh_scope];
