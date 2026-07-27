/**
 * Lingxi deadline refresh script (standalone / daily inspection fallback)
 *
 * Reads state via unified Storage module, refreshes daysLeft / overdue for all
 * currentGoals, and backfills missing priorities with a neutral default (50).
 * The engine no longer applies rule-based priority formulas; AI/user owns the scores.
 *
 * This is the standalone fallback for "no MCP environment" (cron / manual / daily
 * automation). When MCP is available, prefer lingxi_recalc_priorities.
 *
 * Uses the unified Storage module (same as MCP, Dashboard, Electron) to ensure
 * all three ends see consistent data.
 */

const fs = require('fs');
const path = require('path');

// Use shared config loader (same as MCP / Dashboard / Electron)
const { loadConfig } = require('../lib/config');
const CONFIG = loadConfig();
const DATA_DIR = CONFIG.dataDir;
const { ensureDataInitialized } = require('../lib/init-data');
ensureDataInitialized(DATA_DIR);

const Storage = require('../engine/storage');
Storage.setDataDir(DATA_DIR);

function daysBetween(deadline) {
  if (!deadline) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dl = new Date(deadline);
  dl.setHours(0, 0, 0, 0);
  return Math.round((dl - today) / (1000 * 60 * 60 * 24));
}

// === Main ===

function main() {
  const state = Storage.readFullState();
  const now = new Date().toISOString();
  const goals = (state.currentGoals || []).filter(g => !g.completed);
  let changedCount = 0;

  for (const g of goals) {
    if (g.deadline) {
      const dl = daysBetween(g.deadline);
      g.daysLeft = dl;
      g.overdue = dl < 0;
    } else {
      g.daysLeft = null;
      g.overdue = false;
    }
    g.lastRecalculated = now;

    if (g.priority === undefined || g.priority === null) {
      g.priority = 50;
      g.updatedAt = now;
      changedCount++;
      console.log(`  [Default] ${g.title}: priority set to 50 (no prior score)`);
    } else {
      const status = g.overdue ? 'overdue' : (g.daysLeft !== null ? `${g.daysLeft} days` : 'no DDL');
      console.log(`  [Keep] ${g.title}: priority=${g.priority} | DDL=${g.deadline || 'N/A'} | ${status}`);
    }
  }

  state.meta = state.meta || {};
  state.meta.lastUpdated = now;

  // Write back via unified Storage (hierarchy + flat files + state.json)
  Storage.writeState(state);

  console.log(`\nRecalc complete: ${changedCount} goals received a default priority`);
  console.log(`Current goals status:`);
  (state.currentGoals || []).filter(g => !g.completed).forEach(g => {
    const status = g.overdue ? 'overdue' : (g.daysLeft !== null ? `${g.daysLeft} days` : 'no DDL');
    console.log(`  - ${g.title} | priority=${g.priority} | DDL=${g.deadline || 'N/A'} | ${status}`);
  });
}

main();