#!/usr/bin/env node
/*
 * Headless re-implementation of the "Retrieve current version from Instance"
 * command (extension.refreshFromInstance in src/extension.ts) plus its
 * response handler, for use without VS Code running.
 *
 * It ports the request-building logic from ExtensionUtils.fileNameToObject()
 * and the response handler from extension.ts's `actionGoal == 'getCurrent'`
 * branch, so it can talk directly to the sn-scriptsync WebSocket server
 * (ws://127.0.0.1:1978) that the extension starts, without needing the
 * extension host itself in the loop.
 *
 * Usage:
 *   node scripts/retrieve-from-instance.js <workspaceRoot> <synced-file-path>
 *
 * <workspaceRoot> is the sync folder (the one containing <instance>/ folders).
 * <synced-file-path> is the file to refresh, absolute or relative to CWD.
 *
 * Requires: the sn-scriptsync extension's WebSocket server running (i.e. the
 * extension is enabled in a VS Code window) and the SN Utils helper browser
 * tab connected to it, exactly as the manual command requires.
 */

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const WS_URL = 'ws://127.0.0.1:1978';
const RESPONSE_TIMEOUT_MS = 20000;

function getInstanceSettings(workspaceRoot, instanceName) {
  const newPath = path.join(workspaceRoot, instanceName, '_settings.json');
  const oldPath = path.join(workspaceRoot, instanceName, 'settings.json');
  const p = fs.existsSync(newPath) ? newPath : (fs.existsSync(oldPath) ? oldPath : null);
  if (!p) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) || {};
  } catch {
    return {};
  }
}

function getFileAsJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) || {};
  } catch {
    return {};
  }
}

function getFileAsArray(p) {
  try {
    return fs.readFileSync(p, 'utf-8').split('\n') || [];
  } catch {
    return [];
  }
}

function isValidParsedScriptObject(scriptObj) {
  if (!scriptObj || typeof scriptObj !== 'object') return false;
  if (!scriptObj.fileName || !scriptObj.tableName || !scriptObj.fieldName) return false;
  if (!scriptObj.instance || typeof scriptObj.instance !== 'object') return false;
  if (!scriptObj.instance.name || !scriptObj.instance.url) return false;
  if (typeof scriptObj.content !== 'string') return false;
  return true;
}

// Port of ExtensionUtils.fileNameToObject(). Mirrors src/ExtensionUtils.ts:476.
function fileNameToObject(workspaceRoot, fileName) {
  let content;
  try {
    content = fs.readFileSync(fileName, 'utf-8');
  } catch {
    return null;
  }

  const fileNameUse = fileName.replace(workspaceRoot, '');
  const fileNameArr = fileNameUse.split(/\\|\/|\.|\^/).slice(1);
  const basePath = path.join(workspaceRoot, fileNameArr[0]) + path.sep;
  const fullPath = basePath + fileNameArr[1] + path.sep + fileNameArr[2] + path.sep;

  if (fileNameArr[5] === 'ts') return null;

  // sp_ng_template layout: <instance>/<scope>/sp_widget/<widget>/sp_ng_template/<field>^<name>^<sys_id>.<ext>
  if (path.basename(path.dirname(fileName)) === 'sp_ng_template') {
    const baseName = path.basename(fileName);
    const parts = baseName.split('^');
    if (parts.length >= 3) {
      const lastSegment = parts[parts.length - 1];
      const scriptObj = {};
      scriptObj.instance = getInstanceSettings(workspaceRoot, fileNameArr[0]);
      scriptObj.tableName = 'sp_ng_template';
      scriptObj.fieldName = parts[0];
      scriptObj.name = parts.slice(1, parts.length - 1).join('^');
      scriptObj.sys_id = lastSegment.replace(/\.[^.]+$/, '');
      scriptObj.scopeName = fileNameArr[1];
      scriptObj.fileName = fileName;
      scriptObj.content = content;
      return isValidParsedScriptObject(scriptObj) ? scriptObj : null;
    }
  }

  if (fileNameArr.length === 8) {
    const fileNme = fileNameArr[2] + '.' + fileNameArr[3] + '.' + fileNameArr[4];
    fileNameArr.splice(2, 1);
    fileNameArr.splice(2, 1);
    fileNameArr[2] = fileNme;
  }

  if (fileNameArr.length < 5) {
    console.error('This command can only be executed from a synced file.');
    return null;
  }

  // Modern "6-part" layout: <instance>/<scope>/<table>/<name>.<field>.<ext>
  if (fileNameArr.length === 6) {
    let scopes = { global: 'global' };
    if (fileNameArr[1] !== 'global') scopes = getFileAsJson(basePath + 'scopes.json');
    const objNameToSysId = getFileAsJson(fullPath + '_map.json');

    const scriptObj = {};
    scriptObj.instance = getInstanceSettings(workspaceRoot, fileNameArr[0]);
    scriptObj.tableName = fileNameArr[2];
    scriptObj.name = fileNameArr[3];
    scriptObj.fieldName = fileNameArr[4];
    scriptObj.sys_id = objNameToSysId[fileNameArr[3]] || '';
    scriptObj.scopeName = fileNameArr[1];
    if (Object.prototype.hasOwnProperty.call(scopes, fileNameArr[1])) {
      scriptObj.scope = scopes[fileNameArr[1]];
    }
    scriptObj.fileName = fileName;
    scriptObj.content = content;

    if (fileNameArr[2] === 'sp_widget') {
      scriptObj.testUrls = getFileAsArray(path.dirname(scriptObj.fileName) + path.sep + '_test_urls.txt');
    }

    return isValidParsedScriptObject(scriptObj) ? scriptObj : null;
  }

  // Legacy 5-part layout, incl. sp_widget / sp_ng_template sub-cases.
  if ((fileNameArr[4].length !== 32 && fileNameArr[1] !== 'sp_widget') && fileNameArr[1] !== 'background') {
    return null;
  }

  const scriptObj = {};
  scriptObj.instance = getInstanceSettings(workspaceRoot, fileNameArr[0]);
  scriptObj.tableName = fileNameArr[1];

  if (fileNameArr[4].length === 32) {
    scriptObj.name = fileNameArr[3];
    scriptObj.fieldName = fileNameArr[2];
    scriptObj.sys_id = fileNameArr[4];
  } else if (fileNameArr[1] === 'sp_widget') {
    scriptObj.name = fileNameArr[2];
    scriptObj.testUrls = getFileAsArray(basePath + path.sep + scriptObj.name + path.sep + 'test_urls.txt');

    if (fileNameArr[3] !== 'sp_ng_template') {
      const nameToField = {
        '1 HTML Template': 'template',
        '2 SCSS': 'css',
        '3 Client Script': 'client_script',
        '4 Server Script': 'script',
        '5 Link function': 'link',
        '6 Option schema': 'option_schema',
      };
      const widgetjson = getFileAsJson(basePath + path.sep + scriptObj.name + path.sep + 'widget.json');
      scriptObj.fieldName = nameToField[fileNameArr[3]];
      scriptObj.sys_id = widgetjson.sys_id;
      scriptObj.scope = widgetjson.widget && widgetjson.widget.sys_scope && widgetjson.widget.sys_scope.value;
    } else {
      scriptObj.tableName = fileNameArr[3];
      scriptObj.fieldName = fileNameArr[4];
      scriptObj.sys_id = fileNameArr[6];
    }
  }

  scriptObj.fileName = fileName;
  scriptObj.content = content;
  return isValidParsedScriptObject(scriptObj) ? scriptObj : null;
}

// Mirrors extension.ts refreshFromInstance()'s mutation of the parsed object.
function buildRequestRecordPayload(scriptObj) {
  const req = { ...scriptObj };
  req.action = 'requestRecord';
  req.actionGoal = 'getCurrent';
  req.sys_id = req.sys_id + '?sysparm_fields=name,sys_updated_on,sys_updated_by,sys_scope.scope,' + req.fieldName;
  req.appName = 'headless-retrieve-script';
  return req;
}

// Mirrors extension.ts's `actionGoal == 'getCurrent'` handler:
//   eu.writeFile(messageJson.fileName, messageJson.result[messageJson.fieldName], true, cb)
// minus the VS Code editor-open side effect, which has no headless equivalent.
function handleGetCurrentResponse(messageJson) {
  const contents = messageJson.result[messageJson.fieldName];
  fs.mkdirSync(path.dirname(messageJson.fileName), { recursive: true });
  fs.writeFileSync(messageJson.fileName, contents);
  console.log(`Wrote ${contents.length} chars to ${messageJson.fileName}`);
}

function main() {
  const [, , workspaceRootArg, fileArg] = process.argv;
  if (!workspaceRootArg || !fileArg) {
    console.error('Usage: node scripts/retrieve-from-instance.js <workspaceRoot> <synced-file-path>');
    process.exit(1);
  }

  const workspaceRoot = path.resolve(workspaceRootArg);
  const fileName = path.resolve(fileArg);

  const scriptObj = fileNameToObject(workspaceRoot, fileName);
  if (!scriptObj) {
    console.error('Could not parse this file as a synced sn-scriptsync artifact.');
    process.exit(1);
  }

  const requestPayload = buildRequestRecordPayload(scriptObj);

  const ws = new WebSocket(WS_URL);
  const timeout = setTimeout(() => {
    console.error(`Timed out after ${RESPONSE_TIMEOUT_MS}ms waiting for a response.`);
    ws.close();
    process.exit(1);
  }, RESPONSE_TIMEOUT_MS);

  ws.on('open', () => {
    console.log('Connected. Sending requestRecord/getCurrent for', fileName);
    ws.send(JSON.stringify(requestPayload));
  });

  ws.on('message', (data) => {
    let messageJson;
    try {
      messageJson = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (messageJson.actionGoal === 'getCurrent' && messageJson.fileName === fileName) {
      clearTimeout(timeout);
      handleGetCurrentResponse(messageJson);
      ws.close();
      process.exit(0);
    }
  });

  ws.on('error', (err) => {
    clearTimeout(timeout);
    console.error('WebSocket error:', err.message);
    console.error('Is the sn-scriptsync extension running (server started) with the helper tab connected?');
    process.exit(1);
  });
}

main();
