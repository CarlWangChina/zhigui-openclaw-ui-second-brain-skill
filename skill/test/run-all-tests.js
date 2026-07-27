/**
 * Compatibility entry point for the isolated Lingxi test suite.
 *
 * All tests use temporary data directories. Running this file never mutates
 * the dashboard data under .lingxi.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const testFiles = ['core-scenarios.js', 'integration-actions.js', 'http-dashboard.js', 'mechanism-audit.js'];

for (const file of testFiles) {
  const result = spawnSync(process.execPath, [path.join(__dirname, file)], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'test' },
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

console.log('PASS all isolated Lingxi tests');
