#!/usr/bin/env node
/**
 * 迁移脚本：将现有 goals/errands/notes/history 数据迁移到事件流
 * 用法：node scripts/migrate-to-events.js
 */
const fs = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname, '..', '.lingxi');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');

function readJson(fp) { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; } }
function writeJson(fp, d) { fs.writeFileSync(fp, JSON.stringify(d, null, 2), 'utf8'); }
function genEventId(dateStr, idx) { return `evt_${(dateStr || new Date().toISOString().slice(0,10)).replace(/-/g,'')}_${String(idx).padStart(3,'0')}`; }

console.log('=== 灵犀事件流迁移 ===\n');

// 安全守卫：若事件流已存在真实事件，避免清空现有数据
const existingEvents = readJson(EVENTS_FILE);
if (existingEvents?.events && existingEvents.events.length > 0) {
  console.error('[中止] events.json 已包含 ' + existingEvents.events.length + ' 条事件，迁移会覆盖现有事件流。');
  console.error('       如需重新迁移，请先备份并清空 events.json（mv .lingxi/events.json .lingxi/events.json.bak）。');
  process.exit(1);
}

const events = [];
let c = 0;

// 1. history
const history = readJson(path.join(DATA_DIR, 'history.json'));
if (history?.conversations) {
  for (const conv of history.conversations) {
    c++;
    events.push({
      id: genEventId(conv.timestamp?.slice(0,10), c), timestamp: conv.timestamp || new Date().toISOString(),
      source: 'conversation', rawInput: conv.userMessage || '', domains: [], type: 'event',
      extracted: { facts: [], followUpNeeded: false, followUpItems: [] },
      derivedRecords: [], reminders: [], status: 'archived', resolvedAt: conv.timestamp,
      relatedEvents: [], aiResponse: conv.aiResponse || '', migratedFrom: 'history',
    });
  }
  console.log(`  history: ${history.conversations.length} 条`);
}

// 2. goals
const goals = readJson(path.join(DATA_DIR, 'goals.json'));
if (goals) {
  const all = [
    ...(goals.strategicGoals||[]).map(g=>({...g,_t:'strategicGoal'})),
    ...(goals.currentGoals||[]).map(g=>({...g,_t:'currentGoal'})),
    ...(goals.constraints||[]).map(g=>({...g,_t:'constraint'})),
  ];
  for (const g of all) {
    c++;
    events.push({
      id: genEventId(g.createdAt?.slice(0,10), c), timestamp: g.createdAt||new Date().toISOString(),
      source:'migration', rawInput: g.title||'', domains: g.domain?[g.domain]:[],
      type: g._t==='constraint'?'constraint':'goal',
      extracted: { facts:[{domain:g.domain||'misc',content:g.title}], followUpNeeded:false, followUpItems:[] },
      derivedRecords:[{file:'goals.json',recordId:g.id,field:g._t}],
      reminders:[], status:'archived', resolvedAt:g.createdAt, relatedEvents:[], migratedFrom:'goals',
    });
  }
  console.log(`  goals: ${all.length} 条`);
}

// 3. errands
const errands = readJson(path.join(DATA_DIR, 'errands.json'));
if (errands?.errands) {
  for (const e of errands.errands) {
    c++;
    events.push({
      id: genEventId(e.createdAt?.slice(0,10), c), timestamp: e.createdAt||new Date().toISOString(),
      source:'migration', rawInput: e.title||'', domains:[], type:'errand',
      extracted: { facts:[{domain:'misc',content:e.title,when:e.date}], followUpNeeded:false, followUpItems:[] },
      derivedRecords:[{file:'errands.json',recordId:e.id,field:'errands'}],
      reminders:[], status: e.completed?'archived':'resolved', resolvedAt: e.createdAt,
      relatedEvents:[], migratedFrom:'errands',
    });
  }
  console.log(`  errands: ${errands.errands.length} 条`);
}

// 4. notes
const notes = readJson(path.join(DATA_DIR, 'notes.json'));
if (notes?.notes) {
  for (const [domain, list] of Object.entries(notes.notes)) {
    for (const n of list) {
      c++;
      events.push({
        id: genEventId(n.createdAt?.slice(0,10), c), timestamp: n.createdAt||new Date().toISOString(),
        source: n.source||'migration', rawInput: n.content||'', domains:[domain], type:'note',
        extracted: { facts:[{domain,content:n.content,when:n.relatedDate}], followUpNeeded:false, followUpItems:[] },
        derivedRecords:[{file:'notes.json',recordId:n.id,field:domain}],
        reminders:[], status:'archived', resolvedAt: n.createdAt, relatedEvents:[], migratedFrom:'notes',
      });
    }
  }
  console.log('  notes: 完成');
}

events.sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp));
writeJson(EVENTS_FILE, { meta:{version:'3.0.0',lastUpdated:new Date().toISOString(),totalEvents:events.length}, events, pendingFollowUps:[] });
console.log(`\n  总计 ${events.length} 条事件 → events.json`);
console.log('  迁移完成。\n');