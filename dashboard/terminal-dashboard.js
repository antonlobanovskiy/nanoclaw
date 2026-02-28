#!/usr/bin/env node
/**
 * NanoClaw Terminal Monitor
 * Reads data directly from filesystem — no API server dependency.
 *
 * Controls: Tab=cycle agents  ↑↓=scroll  g=follow  r=restart  q=quit
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { exec } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// ── Paths ────────────────────────────────────────────────────────────────────
const HOME = os.homedir();
const BASE = path.join(HOME, 'dev/NanoClaw');
const DB_PATH = path.join(BASE, 'store/messages.db');
const LOG_PATH = path.join(BASE, 'logs/nanoclaw.log');
const SESSIONS_DIR = path.join(BASE, 'data/sessions');
const IPC_DIR = path.join(BASE, 'data/ipc');

// ── ANSI ─────────────────────────────────────────────────────────────────────
const ESC = '\x1b[';
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const CLEAR = `${ESC}2J${ESC}H`;
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const RED = `${ESC}31m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const CYAN = `${ESC}36m`;
const WHITE = `${ESC}37m`;
const GRAY = `${ESC}90m`;
const ORANGE = `${ESC}33m`;
const B_GREEN = `${ESC}92m`;

// ── Box drawing ───────────────────────────────────────────────────────────────
const BOX = {
  TL:'╔', TR:'╗', BL:'╚', BR:'╝', H:'═', V:'║',
  LJ:'╠', RJ:'╣', TJ:'╦', BJ:'╩', X:'╬',
  h:'─', v:'│', lj:'╟', rj:'╢', tj:'┬', bj:'┴',
};

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  groups: [],
  agents: [],
  selectedAgent: null,
  transcript: [],
  transcriptScroll: 0,
  serviceLog: [],
  serviceStatus: 'unknown',
  cpu: 0,
  mem: 0,
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function clamp(str, width) {
  if (str.length > width) return str.slice(0, width - 1) + '…';
  return str.padEnd(width);
}

function now() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

// ── Data: Registered groups ───────────────────────────────────────────────────
function loadGroups() {
  try {
    const Database = require('/home/antonlobanovskiy/dev/NanoClaw/dashboard/api/node_modules/better-sqlite3');
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    state.groups = db.prepare('SELECT name, folder FROM registered_groups').all();
    db.close();
  } catch {
    // DB not ready yet
  }
}

// ── Data: Service status ──────────────────────────────────────────────────────
function checkServiceStatus() {
  exec('systemctl --user is-active nanoclaw', (err, stdout) => {
    state.serviceStatus = stdout.trim() || (err ? 'inactive' : 'unknown');
  });
}

// ── Data: System resources ────────────────────────────────────────────────────
let _cpuPrev = null;
function readSystemStats() {
  const cpus = os.cpus();
  const curr = cpus.reduce((a, c) => {
    const t = Object.values(c.times).reduce((s, v) => s + v, 0);
    return { total: a.total + t, idle: a.idle + c.times.idle };
  }, { total: 0, idle: 0 });

  if (_cpuPrev) {
    const dt = curr.total - _cpuPrev.total;
    const di = curr.idle - _cpuPrev.idle;
    state.cpu = dt > 0 ? Math.round((1 - di / dt) * 100) : 0;
  }
  _cpuPrev = curr;

  const total = os.totalmem();
  const free = os.freemem();
  state.mem = Math.round((1 - free / total) * 100);
}

// ── Data: Agent activity ──────────────────────────────────────────────────────
function findLatestJsonl(groupName) {
  const sessionBase = path.join(SESSIONS_DIR, groupName, '.claude', 'projects');
  try {
    const projectDirs = fs.readdirSync(sessionBase);
    let latest = null;
    for (const dir of projectDirs) {
      const dirPath = path.join(sessionBase, dir);
      let entries;
      try { entries = fs.readdirSync(dirPath); } catch { continue; }
      const files = entries.filter(f => f.endsWith('.jsonl'));
      for (const f of files) {
        const fp = path.join(dirPath, f);
        try {
          const st = fs.statSync(fp);
          if (!latest || st.mtimeMs > latest.mtime) {
            latest = { path: fp, mtime: st.mtimeMs };
          }
        } catch { }
      }
    }
    return latest;
  } catch {
    return null;
  }
}

function getLastToolCall(jsonlPath) {
  try {
    const content = fs.readFileSync(jsonlPath, 'utf8');
    const lines = content.trim().split('\n').reverse();
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'assistant') {
          const content = obj.message?.content ?? [];
          for (const c of content) {
            if (c.type === 'tool_use') {
              const inputStr = typeof c.input === 'object'
                ? Object.values(c.input)[0] ?? ''
                : String(c.input);
              return `${c.name} › ${String(inputStr).slice(0, 40)}`;
            }
          }
        }
      } catch { }
    }
  } catch { }
  return null;
}

function scanAgents() {
  const nowMs = Date.now();
  state.agents = state.groups.map(g => {
    const latest = findLatestJsonl(g.folder ?? g.name);
    const active = latest && (nowMs - latest.mtime) < 60_000;
    const currentTool = active ? getLastToolCall(latest.path) : null;
    const lastSeen = latest ? latest.mtime : null;
    const uptime = active && lastSeen ? nowMs - lastSeen : null;
    return { name: g.folder ?? g.name, active, currentTool, lastSeen, uptime };
  });

  // Auto-select most recently active agent
  const activeAgents = state.agents.filter(a => a.active).sort((a, b) => b.lastSeen - a.lastSeen);
  if (activeAgents.length > 0 && !state.agents.find(a => a.name === state.selectedAgent && a.active)) {
    state.selectedAgent = activeAgents[0].name;
  } else if (!state.selectedAgent && state.agents.length > 0) {
    state.selectedAgent = state.agents[0].name;
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
process.stdout.write(HIDE_CURSOR + CLEAR);

function cleanup() {
  process.stdout.write(SHOW_CURSOR + `${ESC}?1049l`);
  process.exit(0);
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// ── Poll loop ─────────────────────────────────────────────────────────────────
loadGroups();
checkServiceStatus();
readSystemStats();
scanAgents();

setInterval(loadGroups, 30_000);
setInterval(checkServiceStatus, 5_000);
setInterval(readSystemStats, 2_000);
setInterval(scanAgents, 2_000);

// Debug: dump state every 3s
setInterval(() => {
  process.stdout.write(CLEAR);
  process.stdout.write(JSON.stringify(state.agents, null, 2) + '\n');
  process.stdout.write(`cpu: ${state.cpu}%  mem: ${state.mem}%  service: ${state.serviceStatus}\n`);
  process.stdout.write(state.serviceLog.slice(-5).join('\n') + '\n');
}, 3_000);
