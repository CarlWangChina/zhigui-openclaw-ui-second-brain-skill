#!/usr/bin/env node
/**
 * ZhiGui · MCP Server registration helper
 *
 * Prints setup guidance for connecting the zhigui MCP server to AI tools.
 * The actual config must be added through each tool's MCP settings UI.
 *
 * Usage:
 *   node <skillDir>/scripts/register-mcp.js [skillDir] [nodeExe]
 */

const path = require('path');

function defaultSkillDir() {
  return path.resolve(__dirname, '..');
}

function register(skillDir, nodeExe) {
  skillDir = skillDir || defaultSkillDir();
  nodeExe = nodeExe || process.execPath;
  const enginePath = path.join(skillDir, 'engine', 'server.js').replace(/\\/g, '/');

  console.log('[ZhiGui] MCP server configuration:');
  console.log(`  engine : ${enginePath}`);
  console.log(`  command: ${nodeExe}`);
  console.log('');
  console.log('  To connect zhigui to your AI tool:');
  console.log('  1. Open your tool\'s MCP settings (e.g. Trae: Settings > MCP > Add > Manual Add)');
  console.log('  2. Add a server entry:');
  console.log('     {');
  console.log('       "mcpServers": {');
  console.log('         "zhigui": {');
  console.log(`           "command": "${nodeExe.replace(/\\/g, '/')}",`);
  console.log(`           "args": ["${enginePath}"]`);
  console.log('         }');
  console.log('       }');
  console.log('     }');
  console.log('  3. See mcp-config-template.json for cross-platform examples.');
  console.log('');
  return { enginePath, nodeExe };
}

if (require.main === module) {
  const skillDir = process.argv[2] || undefined;
  const nodeExe = process.argv[3] || undefined;
  register(skillDir, nodeExe);
}

module.exports = { register, defaultSkillDir };
