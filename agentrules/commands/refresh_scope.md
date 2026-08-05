### `refresh_scope` ⚡
Reset every locally synced file in a scope back to the instance's current values — a drift-guard/reset ritual for when local files may have diverged from the instance (or before starting work, to guarantee a clean baseline). This overwrites local files with instance content; it never writes to the instance.

**Request:**
```json
{ "id": "rs1", "command": "refresh_scope", "params": { "scopeName": "x_app_scope" } }
```

**Parameters:**
- `scopeName` (optional): the scope's folder name under the instance (e.g. `"global"` or your app's folder name). Omit it when the instance has exactly one scope folder — it's inferred automatically; with more than one, `scopeName` is required (`E_INVALID_PARAMS` lists the candidates).
- `includeEmpty` (optional, default `false`): also write empty code fields to disk, matching the VS Code "Load/Refresh artifacts from scope (include empty)" variant. Off by default to avoid creating empty noise files for unused fields.

**Response:**
```json
{
  "status": "success",
  "result": {
    "scopeName": "x_app_scope",
    "scope": "x_app_scope",
    "tablesRefreshed": 2,
    "filesWritten": 7,
    "tables": [
      { "table": "sys_script_include", "records": 4, "filesWritten": 4 },
      { "table": "sp_widget", "records": 1, "filesWritten": 3 }
    ]
  }
}
```

**Notes:**
- Two-stage round trip through the browser session: first lists every record `sys_metadata` reports in the scope, then fetches the real field content for every table sn-scriptsync tracks a code field on (Script Includes' `script`, widgets' `template`/`css`/`client_script`/etc., ...) — all tables fetched concurrently — and overwrites the corresponding local file(s) for each.
- If a table returns nothing (no code-bearing tables found in the scope at all), the response reports `tablesRefreshed: 0` with an explanatory `message` and no error.
- Both the scope listing and each table's field fetch are paginated (1000/page and 200/page respectively) rather than capped at a single request, up to a 50,000/20,000-record safety ceiling per scope/table. If a ceiling is hit, the response includes `scopeListingTruncated: true` and/or a `truncatedTables` array — treat the refresh as partial and use `query_records`/`get_record` to fill in what's missing.
- Unknown `scopeName` (no matching entry in the instance's `scopes.json`) fails with `E_INSTANCE_NOT_FOUND` — sync at least one file from that scope via VS Code first so `scopes.json` gets populated, or pass the scope's internal name directly.
