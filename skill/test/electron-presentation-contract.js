const assert = require('assert');
const fs = require('fs');
const path = require('path');

const electronMain = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
const dashboard = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'public', 'dashboard.js'), 'utf8');

assert.ok(electronMain.includes('const restoreCollapsed = savedState.meta?.collapsed === true;'),
  'Electron startup must restore the saved presentation mode, not just its bounds');
assert.ok(electronMain.includes('restoreCollapsed\n    ? COLLAPSED_W'),
  'a saved mini mode must create a mini-sized native window');
assert.ok(electronMain.includes('Number(savedBounds.width) > COLLAPSED_W'),
  'a stale mini-sized bound must never be reused for an expanded panel');
assert.ok(dashboard.includes("collapsed = state.meta?.collapsed === true;"),
  'the renderer must mirror the saved Electron presentation mode');
assert.equal(dashboard.includes('collapsed = false;\n    document.body.classList.add(\'expanded\');'), false,
  'the renderer must not force a full dashboard into a restored mini window');

console.log('PASS electron-presentation-contract');
