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
    const Database = require(path.join(BASE, 'dashboard/api/node_modules/better-sqlite3'));
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
          if (!st.isFile()) continue;
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
    const st = fs.statSync(jsonlPath);
    const readSize = Math.min(16384, st.size);
    const buf = Buffer.alloc(readSize);
    const fd = fs.openSync(jsonlPath, 'r');
    fs.readSync(fd, buf, 0, readSize, st.size - readSize);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').reverse();
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
  if (state.selectedAgent) watchTranscript(state.selectedAgent);
}

// ── Data: Service log watcher ─────────────────────────────────────────────────
let _logOffset = 0;

function initLogWatcher() {
  // Seed with last 50 lines
  try {
    const content = fs.readFileSync(LOG_PATH, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    state.serviceLog = lines.slice(-50);
    _logOffset = Buffer.byteLength(content, 'utf8');
  } catch { }

  fs.watchFile(LOG_PATH, { interval: 500 }, () => {
    try {
      const fd = fs.openSync(LOG_PATH, 'r');
      try {
        const stat = fs.fstatSync(fd);
        if (stat.size < _logOffset) _logOffset = 0; // log rotated

        const toRead = stat.size - _logOffset;
        if (toRead > 0) {
          const buf = Buffer.alloc(toRead);
          fs.readSync(fd, buf, 0, toRead, _logOffset);
          _logOffset += toRead;

          const newLines = buf.toString('utf8').split('\n').filter(Boolean);
          state.serviceLog.push(...newLines);
          if (state.serviceLog.length > 200) state.serviceLog = state.serviceLog.slice(-200);
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch { }
  });
}

// ── Data: Transcript watcher ──────────────────────────────────────────────────
let _transcriptFile = null;
let _transcriptOffset = 0;

function parseJsonlEvent(obj) {
  const events = [];
  if (!obj || typeof obj !== 'object') return events;

  if (obj.type === 'user') {
    const raw = typeof obj.message?.content === 'string'
      ? obj.message.content
      : JSON.stringify(obj.message?.content ?? '');
    // Strip XML wrapper if present: <messages><message ...>TEXT</message></messages>
    const text = raw.replace(/<messages>[\s\S]*?<message[^>]*>([\s\S]*?)<\/message>[\s\S]*?<\/messages>/g, '$1').trim();
    if (text) events.push({ kind: 'user', text });
  }

  if (obj.type === 'assistant') {
    const content = obj.message?.content ?? [];
    for (const c of content) {
      if (c.type === 'text' && c.text?.trim()) {
        events.push({ kind: 'assistant', text: c.text.trim() });
      }
      if (c.type === 'tool_use') {
        const inputLines = typeof c.input === 'object'
          ? Object.entries(c.input).map(([k, v]) => `  ${k}: ${String(v).slice(0, 200)}`)
          : [`  ${String(c.input).slice(0, 200)}`];
        events.push({ kind: 'tool_use', name: c.name, inputLines });
      }
    }
  }

  if (obj.type === 'tool') {
    const parts = obj.content ?? [];
    for (const p of parts) {
      const lines = (p.content ?? [])
        .filter(c => c.type === 'text')
        .flatMap(c => c.text.split('\n'));
      const truncated = lines.length > 20
        ? [...lines.slice(0, 20), `  … ${lines.length - 20} more lines`]
        : lines;
      events.push({ kind: 'tool_result', lines: truncated.map(l => `  ${l}`) });
    }
  }

  return events;
}

function loadTranscript(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    _transcriptOffset = Buffer.byteLength(content, 'utf8');
    state.transcript = [];
    for (const line of content.split('\n').filter(Boolean)) {
      try { state.transcript.push(...parseJsonlEvent(JSON.parse(line))); } catch { }
    }
    if (state.transcript.length > 500) state.transcript = state.transcript.slice(-500);
    state.transcriptScroll = 0;
  } catch { }
}

function watchTranscript(groupName) {
  const latest = findLatestJsonl(groupName);
  if (!latest) return;

  if (latest.path !== _transcriptFile) {
    if (_transcriptFile) fs.unwatchFile(_transcriptFile);
    _transcriptFile = latest.path;
    _transcriptOffset = 0;
    loadTranscript(_transcriptFile);
    state.transcript.unshift({ kind: 'divider', text: '── new session ──' });

    fs.watchFile(_transcriptFile, { interval: 500 }, () => {
      try {
        const fd = fs.openSync(_transcriptFile, 'r');
        try {
          const stat = fs.fstatSync(fd);
          const toRead = stat.size - _transcriptOffset;
          if (toRead > 0) {
            const buf = Buffer.alloc(toRead);
            fs.readSync(fd, buf, 0, toRead, _transcriptOffset);
            _transcriptOffset += toRead;
            for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
              try { state.transcript.push(...parseJsonlEvent(JSON.parse(line))); } catch { }
            }
            if (state.transcript.length > 500) state.transcript = state.transcript.slice(-500);
          }
        } finally {
          fs.closeSync(fd);
        }
      } catch { }
    });
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
initLogWatcher();
checkServiceStatus();
readSystemStats();
scanAgents();

setInterval(loadGroups, 30_000);
setInterval(checkServiceStatus, 5_000);
setInterval(readSystemStats, 2_000);
setInterval(scanAgents, 2_000);

// ── Render helpers ────────────────────────────────────────────────────────────
const ANSI_RE = /\x1b\[[^m]*m/g;
function stripAnsi(str) { return str.replace(ANSI_RE, ''); }
function stripAnsiLen(str) { return stripAnsi(str).length; }

function termSize() {
  return { cols: process.stdout.columns || 120, rows: process.stdout.rows || 40 };
}

function colorizeLog(line) {
  if (/\bERROR\b|\bERR\b/.test(line)) return RED + line + RESET;
  if (/\bWARN\b|\bWARNING\b/.test(line)) return ORANGE + line + RESET;
  return DIM + line + RESET;
}

function renderBar(value, width, color) {
  const filled = Math.round(Math.max(0, Math.min(100, value)) / 100 * width);
  return color + '█'.repeat(filled) + RESET + DIM + '░'.repeat(width - filled) + RESET;
}

function formatAge(mtime) {
  const sec = Math.floor((Date.now() - mtime) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

function renderTranscript(width, height) {
  const lines = [];
  for (const ev of state.transcript) {
    switch (ev.kind) {
      case 'divider':
        lines.push(GRAY + ev.text.slice(0, width - 1).padEnd(width - 1) + RESET);
        break;
      case 'user':
        lines.push(CYAN + BOLD + '[user]' + RESET);
        for (const l of ev.text.split('\n').slice(0, 10)) {
          lines.push('  ' + l.slice(0, width - 3));
        }
        lines.push('');
        break;
      case 'assistant':
        lines.push(GREEN + BOLD + '[assistant]' + RESET);
        for (const l of ev.text.split('\n').slice(0, 15)) {
          lines.push('  ' + l.slice(0, width - 3));
        }
        lines.push('');
        break;
      case 'tool_use':
        lines.push(YELLOW + BOLD + `[tool_use] ${ev.name}` + RESET);
        for (const l of ev.inputLines ?? []) {
          lines.push(l.slice(0, width - 1));
        }
        lines.push('');
        break;
      case 'tool_result':
        lines.push(DIM + '[tool_result]' + RESET);
        for (const l of ev.lines ?? []) {
          lines.push(DIM + l.slice(0, width - 1) + RESET);
        }
        lines.push('');
        break;
    }
  }
  const total = lines.length;
  const start = Math.max(0, total - height - state.transcriptScroll);
  return lines.slice(start, start + height);
}

function renderServiceLog(width, height) {
  const lines = state.serviceLog.slice(-height).map(l => colorizeLog(l));
  while (lines.length < height) lines.push('');
  return lines;
}

// ── Renderer ──────────────────────────────────────────────────────────────────
function render() {
  const { cols, rows } = termSize();
  const out = [];

  // ── Header ───────────────────────────────────────────────────────────────────
  const statusColor = state.serviceStatus === 'active' ? B_GREEN : RED;
  const statusDot = state.serviceStatus === 'active' ? '●' : '○';
  const agentCount = state.agents.filter(a => a.active).length;
  const headerContent = ` NANOCLAW  ${statusColor}${statusDot} ${state.serviceStatus}${RESET}` +
    `  cpu ${renderBar(state.cpu, 8, CYAN)} ${state.cpu}%` +
    `  mem ${renderBar(state.mem, 8, YELLOW)} ${state.mem}%` +
    `  agents: ${agentCount}  ${BOLD}${now()}${RESET}`;
  const headerPad = Math.max(0, cols - 2 - stripAnsiLen(headerContent));
  out.push(BOX.TL + BOX.H.repeat(cols - 2) + BOX.TR);
  out.push(BOX.V + headerContent + ' '.repeat(headerPad) + BOX.V);

  // ── Agent panel ───────────────────────────────────────────────────────────────
  out.push(BOX.LJ + BOX.H.repeat(cols - 2) + BOX.RJ);
  const agentsLabel = ' AGENTS';
  out.push(BOX.V + BOLD + agentsLabel + RESET + ' '.repeat(cols - 2 - agentsLabel.length) + BOX.V);

  if (state.agents.length === 0) {
    const msg = '  no registered groups';
    out.push(BOX.V + GRAY + msg + RESET + ' '.repeat(cols - 2 - msg.length) + BOX.V);
  } else {
    for (const agent of state.agents) {
      const dot = agent.active ? B_GREEN + '●' + RESET : GRAY + '○' + RESET;
      const name = agent.name.slice(0, 12).padEnd(12);
      const tool = agent.active && agent.currentTool
        ? YELLOW + '► ' + agent.currentTool.slice(0, 50) + RESET
        : GRAY + 'idle' + RESET;
      const age = agent.lastSeen
        ? (agent.active ? GREEN + 'active' + RESET : GRAY + formatAge(agent.lastSeen) + RESET)
        : GRAY + 'never' + RESET;
      const visLen = 1 + 1 + 1 + name.length + 1 + stripAnsiLen(tool) + 1 + stripAnsiLen(age) + 1;
      const pad = Math.max(0, cols - 2 - visLen);
      out.push(`${BOX.V} ${dot} ${name} ${tool}${' '.repeat(pad)} ${age} ${BOX.V}`);
    }
  }

  // ── Split pane ────────────────────────────────────────────────────────────────
  const transcriptCols = Math.floor((cols - 3) * 0.6);
  const logCols = cols - 3 - transcriptCols;

  out.push(BOX.lj + BOX.h.repeat(transcriptCols) + BOX.tj + BOX.h.repeat(logCols) + BOX.rj);

  const tHeader = ` TRANSCRIPT  [${state.selectedAgent ?? 'none'}]`;
  const lHeader = ' SERVICE LOG';
  const tHeaderPad = Math.max(0, transcriptCols - tHeader.length);
  const lHeaderPad = Math.max(0, logCols - lHeader.length);
  out.push(
    BOX.V + BOLD + tHeader + RESET + ' '.repeat(tHeaderPad) +
    BOX.v +
    BOLD + lHeader + RESET + ' '.repeat(lHeaderPad) +
    BOX.V
  );

  const legendRows = 1;
  const fixedRows = out.length + legendRows + 2; // +2 for legend divider + bottom border
  const paneRows = Math.max(1, rows - fixedRows);

  const transcriptLines = renderTranscript(transcriptCols, paneRows);
  const logLines = renderServiceLog(logCols, paneRows);

  for (let i = 0; i < paneRows; i++) {
    const tRaw = transcriptLines[i] ?? '';
    const lRaw = logLines[i] ?? '';
    // Pad to exact visible width (ignoring ANSI codes)
    const tPad = Math.max(0, transcriptCols - stripAnsiLen(tRaw));
    const lPad = Math.max(0, logCols - stripAnsiLen(lRaw));
    out.push(BOX.V + tRaw + ' '.repeat(tPad) + BOX.v + lRaw + ' '.repeat(lPad) + BOX.V);
  }

  // ── Legend ────────────────────────────────────────────────────────────────────
  out.push(BOX.lj + BOX.h.repeat(transcriptCols) + BOX.bj + BOX.h.repeat(logCols) + BOX.rj);
  const legend = `  ${DIM}[Tab]${RESET} cycle agents  ${DIM}[↑↓]${RESET} scroll  ${DIM}[g]${RESET} follow  ${DIM}[r]${RESET} restart service  ${DIM}[q]${RESET} quit`;
  const legendPad = Math.max(0, cols - 2 - stripAnsiLen(legend));
  out.push(BOX.V + legend + ' '.repeat(legendPad) + BOX.V);
  out.push(BOX.BL + BOX.H.repeat(cols - 2) + BOX.BR);

  process.stdout.write(`${ESC}H` + out.join('\n'));
}

setInterval(render, 2_000);
render();
