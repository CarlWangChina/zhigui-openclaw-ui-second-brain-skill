#!/usr/bin/env node
/**
 * Lingxi · Auto-register MCP Server
 *
 * Writes the lingxi MCP server into the global MCP config (~/.lingxi-mcp.json),
 * so any agent in any workspace can call lingxi_* tools directly — no manual config editing.
 *
 * Usage:
 *   node <skillDir>/scripts/register-mcp.js [skillDir] [nodeExe]
 *
 * Notes:
 *   - skillDir defaults to the parent-parent of this file (i.e. the skill root).
 *   - engine path = <skillDir>/engine/server.js, auto-derived from the skill install location,
 *     so after "importing the skill package" there is no need to manually locate the folder.
 *   - command defaults to the node running this script (process.execPath), matching the runtime env.
 *   - This script writes a global config file; some AI tools (e.g. Trae) require manual config
 *     via their UI instead — for those, follow the "Installation & Setup" section in SKILL.md.
 */

const fs = require('fs');
const path = require('path');

function defaultSkillDir() {
  // Default: this file is at <skillDir>/scripts/register-mcp.js
  return path.resolve(__dirname, '..');
}

function register(skillDir, nodeExe) {
  skillDir = skillDir || defaultSkillDir();
  nodeExe = nodeExe || process.execPath;
  const enginePath = path.join(skillDir, 'engine', 'server.js').replace(/\\/g, '/');

  const home = process.env.HOME || process.env.USERPROFILE;
  const globalMcpPath = path.join(home, '.lingxi-mcp.json');

  let cfg = { mcpServers: {} };
  try {
    cfg = JSON.parse(fs.readFileSync(globalMcpPath, 'utf-8'));
    cfg.mcpServers = cfg.mcpServers || {};
  } catch {
    // Global mcp config does not exist yet; create new
  }

  const existed = !!cfg.mcpServers.lingxi;
  cfg.mcpServers.lingxi = {
    command: nodeExe,
    args: [enginePath],
    env: {},
  };

  fs.mkdirSync(path.dirname(globalMcpPath), { recursive: true });
  fs.writeFileSync(globalMcpPath, JSON.stringify(cfg, null, 2), 'utf8');

  console.log(`[Lingxi] MCP server ${existed ? 'updated' : 'registered'}: lingxi`);
  console.log(`  engine : ${enginePath}`);
  console.log(`  command: ${nodeExe}`);
  console.log(`  config : ${globalMcpPath}`);
  console.log(`  Next   : register lingxi in your AI tool's MCP settings (see SKILL.md "Installation & Setup").`);
  return { globalMcpPath, enginePath, nodeExe };
}

// Run when executed directly as a script; only export the function when required by setup.js
if (require.main === module) {
  const skillDir = process.argv[2] || undefined;
  const nodeExe = process.argv[3] || undefined;
  register(skillDir, nodeExe);
}

module.exports = { register, defaultSkillDir };
