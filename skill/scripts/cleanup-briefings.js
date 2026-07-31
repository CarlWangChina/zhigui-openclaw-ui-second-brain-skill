/**
 * ZhiGui briefing cleanup script
 *
 * Briefings are today-only. This one-time cleanup removes any briefing entries
 * in schedule.json whose date is not today, and ensures briefings is an object.
 *
 * Usage:
 *   node scripts/cleanup-briefings.js [DATA_DIR]
 *
 * If DATA_DIR is omitted, uses the config loader (ZHIGUI_DATA_DIR env or
 * config.json). Safe to run multiple times.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { todayStr } = require('../engine/date-utils');

const { loadConfig } = require('../lib/config');
const CONFIG = loadConfig();
let DATA_DIR = process.argv[2] || CONFIG.dataDir;

if (!DATA_DIR) {
  console.error('No data directory provided and no config dataDir found.');
  console.error('Usage: node scripts/cleanup-briefings.js [DATA_DIR]');
  process.exit(1);
}

DATA_DIR = path.resolve(DATA_DIR);
const schedulePath = path.join(DATA_DIR, 'schedule.json');

if (!fs.existsSync(schedulePath)) {
  console.log(`schedule.json not found at ${schedulePath}; nothing to clean.`);
  process.exit(0);
}

const today = todayStr();

let data;
try {
  data = JSON.parse(fs.readFileSync(schedulePath, 'utf-8'));
} catch (e) {
  console.error(`Failed to parse ${schedulePath}:`, e.message);
  process.exit(1);
}

const original = JSON.stringify(data.briefings || {});
const rawBriefings = data.briefings && typeof data.briefings === 'object' && !Array.isArray(data.briefings)
  ? data.briefings
  : {};

const cleaned = {};
for (const d of Object.keys(rawBriefings)) {
  if (d === today) cleaned[d] = rawBriefings[d];
}

data.briefings = cleaned;
data.morningBriefing = cleaned[today] || null;
data.meta = data.meta || {};
data.meta.lastUpdated = new Date().toISOString();

const updated = JSON.stringify(data.briefings);
if (original === updated) {
  console.log(`No stale briefings found. Today: ${today}.`);
} else {
  const backupPath = schedulePath + '.backup-' + new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(backupPath, fs.readFileSync(schedulePath));
  fs.writeFileSync(schedulePath, JSON.stringify(data, null, 2));
  console.log(`Cleaned stale briefings. Kept ${Object.keys(cleaned).length} entry for ${today}.`);
  console.log(`Backup written to ${backupPath}`);
}
