'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'dashboard', 'public', 'index.html'), 'utf8');
const dashboard = fs.readFileSync(path.join(root, 'dashboard', 'public', 'dashboard.js'), 'utf8');
const dashboardServer = fs.readFileSync(path.join(root, 'dashboard', 'server.js'), 'utf8');
const electronMain = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8');
const skill = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');

assert.equal(html.includes('note-import-file'), false, 'the dashboard must not present a delayed file-import queue');
assert.ok(html.includes('note.chatImportHint'), 'the dashboard must direct AI file work to the chat attachment flow');
assert.equal(dashboard.includes('function importNotesFile'), false, 'the old delayed dashboard importer must be removed');
assert.equal(dashboardServer.includes("'/api/note/import'"), false, 'the dashboard HTTP API must not expose delayed file imports');
assert.equal(electronMain.includes("'import-notes'"), false, 'Electron must not expose delayed file imports');
assert.equal(preload.includes('importNotes:'), false, 'the renderer bridge must not expose delayed file imports');
assert.ok(skill.includes('## Files attached in chat'), 'the assistant protocol must require same-turn processing of attached files');

console.log('PASS chat-file-import-contract');
