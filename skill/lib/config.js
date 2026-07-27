/**
 * ZhiGui - Shared config loader
 *
 * Shared by the following three ends, ensuring consistent "data directory / app directory"
 * resolution logic:
 *   - engine/server.js      (MCP Server / AI process)
 *   - dashboard/server.js   (HTTP dashboard service)
 *   - electron/main.js      (desktop main process)
 *
 * config.json and lib/ both live in the skill root directory:
 *   lib/config.js is at <skillDir>/lib/, config.json is at <skillDir>/config.json,
 *   so the config path = path.join(__dirname, '..', 'config.json').
 *
 * dataDir / appDir support relative paths (resolved relative to the config's directory),
 * so the skill package is "import-and-go" on any machine, on any drive, without hardcoded
 * absolute paths.
 */

const fs = require('fs');
const path = require('path');

function loadConfig() {
  const configPath = path.join(__dirname, '..', 'config.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const base = path.dirname(configPath); // skill root directory
    const resolve = (p) => {
      if (!p) return path.join(base, '.zhigui');
      return path.isAbsolute(p) ? p : path.resolve(base, p);
    };
    return {
      dataDir: resolve(process.env.ZHIGUI_DATA_DIR || cfg.dataDir),
      appDir: resolve(cfg.appDir || '.'),
      raw: cfg,
    };
  } catch {
    // Fall back to the default path (when config is missing, data lives in the .zhigui
    // folder under the skill root)
    const base = path.join(__dirname, '..');
    return {
      dataDir: process.env.ZHIGUI_DATA_DIR
        ? path.resolve(process.env.ZHIGUI_DATA_DIR)
        : path.join(base, '.zhigui'),
      appDir: base,
      raw: {},
    };
  }
}

module.exports = { loadConfig };
