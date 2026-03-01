# Terminal Dashboard Rewrite Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rewrite `terminal-dashboard.js` to read data directly from the filesystem and show a focused TUI: agent status, Claude session transcripts, and service logs — no API server dependency, no cost tracking.

**Architecture:** Single Node.js file (`dashboard/terminal-dashboard.js`) using raw ANSI escape codes and `process.stdout.write` for rendering. Data comes from: SQLite (registered groups), JSONL session files (transcript), `nanoclaw.log` (service log), `os` module (CPU/mem), and `systemctl` (service status). No external npm packages added.

**Tech Stack:** Node.js ESM, `better-sqlite3` (already in `api/package.json`), `fs.watchFile`, `readline`, ANSI terminal codes.

**Design doc:** `docs/plans/2026-02-28-terminal-dashboard-design.md`

---

## JSONL Event Format Reference

Session files live at:
```
~/dev/NanoClaw/data/sessions/{group}/.claude/projects/-workspace-group/{sessionId}.jsonl
```

Events to render:
```js
// Skip these types:
{ type: "queue-operation" }
{ type: "system" }

// Render as [user]:
{ type: "user", message: { role: "user", content: "<messages>...</messages>" } }

// Render as [assistant] or [tool_use]:
{
  type: "assistant",
  message: {
    role: "assistant",
    content: [
      { type: "text", text: "..." },                          // → [assistant] text
      { type: "tool_use", name: "Bash", input: { command: "..." } }  // → [tool_use] Bash\n  command
    ]
  }
}

// Render as [tool_result]:
{
  type: "tool",
  content: [
    { type: "tool_result", content: [{ type: "text", text: "..." }] }
  ]
}
```

---

## Task 1: Understand existing file and set up scaffold

**Files:**
- Rewrite: `dashboard/terminal-dashboard.js`

**Step 1: Read the existing file top-to-bottom**

```bash
cat dashboard/terminal-dashboard.js
```

Note: the file is ~992 lines and imports from `http` (API calls we're removing). We keep the ANSI constants and box-drawing characters. Everything else is rewritten.

**Step 2: Replace the file with a minimal scaffold**

```js
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
const ORANGE = `${ESC}33m`;  // 256-color orange approximation
const B_GREEN = `${ESC}92m`;  // Bright green

// ── Box drawing ───────────────────────────────────────────────────────────────
const BOX = {
  TL:'╔', TR:'╗', BL:'╚', BR:'╝', H:'═', V:'║',
  LJ:'╠', RJ:'╣', TJ:'╦', BJ:'╩', X:'╬',
  h:'─', v:'│', lj:'╟', rj:'╢', tj:'┬', bj:'┴',
};

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  groups: [],            // { name, folder } from SQLite
  agents: [],            // { name, active, currentTool, uptime, lastSeen }
  selectedAgent: null,   // name of agent whose transcript is shown
  transcript: [],        // last 500 rendered lines
  transcriptScroll: 0,   // lines from bottom (0 = following)
  serviceLog: [],        // last 200 log lines
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

// ── Entry point ───────────────────────────────────────────────────────────────
process.stdout.write(HIDE_CURSOR + CLEAR);

function cleanup() {
  process.stdout.write(SHOW_CURSOR + `${ESC}?1049l`);
  process.exit(0);
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

console.log('NanoClaw Terminal Monitor - scaffold OK');
setTimeout(cleanup, 2000);
```

**Step 3: Run it**

```bash
node dashboard/terminal-dashboard.js
```

Expected: prints "NanoClaw Terminal Monitor - scaffold OK", exits after 2s.

**Step 4: Commit**

```bash
git add dashboard/terminal-dashboard.js
git commit -m "feat(dashboard): scaffold new terminal monitor"
```

---

## Task 2: Implement data collectors

**Files:**
- Modify: `dashboard/terminal-dashboard.js`

This task adds four data-fetching functions called on a polling loop. No rendering yet.

**Step 1: Add SQLite group reader**

After the state object, add:

```js
// ── Data: Registered groups ───────────────────────────────────────────────────
function loadGroups() {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    state.groups = db.prepare('SELECT name, folder FROM registered_groups').all();
    db.close();
  } catch {
    // DB not ready yet
  }
}
```

**Step 2: Add service status checker**

```js
// ── Data: Service status ──────────────────────────────────────────────────────
function checkServiceStatus() {
  exec('systemctl --user is-active nanoclaw', (err, stdout) => {
    state.serviceStatus = stdout.trim() || (err ? 'inactive' : 'unknown');
  });
}
```

**Step 3: Add CPU/memory reader**

```js
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
```

**Step 4: Add agent activity scanner**

```js
// ── Data: Agent activity ──────────────────────────────────────────────────────
function findLatestJsonl(groupName) {
  const sessionBase = path.join(SESSIONS_DIR, groupName, '.claude', 'projects');
  try {
    // Find all .jsonl files under sessionBase (non-recursive into subagents)
    const projectDirs = fs.readdirSync(sessionBase);
    let latest = null;
    for (const dir of projectDirs) {
      const dirPath = path.join(sessionBase, dir);
      const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
      for (const f of files) {
        const fp = path.join(dirPath, f);
        const st = fs.statSync(fp);
        if (!latest || st.mtimeMs > latest.mtime) {
          latest = { path: fp, mtime: st.mtimeMs };
        }
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
  const now = Date.now();
  state.agents = state.groups.map(g => {
    const latest = findLatestJsonl(g.folder ?? g.name);
    const active = latest && (now - latest.mtime) < 60_000;
    const currentTool = active ? getLastToolCall(latest.path) : null;
    const lastSeen = latest ? latest.mtime : null;
    const uptime = active && lastSeen ? now - lastSeen : null;
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
```

**Step 5: Replace the entry point with a polling loop**

Remove the `console.log` and `setTimeout` at the bottom. Add:

```js
// ── Poll loop ─────────────────────────────────────────────────────────────────
loadGroups();
checkServiceStatus();
readSystemStats();
scanAgents();

setInterval(loadGroups, 30_000);
setInterval(checkServiceStatus, 5_000);
setInterval(readSystemStats, 2_000);
setInterval(scanAgents, 2_000);

// Temp: dump state every 3s so we can verify
setInterval(() => {
  process.stdout.write(CLEAR);
  process.stdout.write(JSON.stringify(state.agents, null, 2) + '\n');
  process.stdout.write(`cpu: ${state.cpu}%  mem: ${state.mem}%  service: ${state.serviceStatus}\n`);
}, 3_000);
```

**Step 6: Run and verify**

```bash
node dashboard/terminal-dashboard.js
```

Expected output (after ~3s):
```
[ { name: 'main', active: false, currentTool: null, ... },
  { name: 'grocery', active: false, ... } ]
cpu: 12%  mem: 54%  service: active
```

Groups should appear. If DB_PATH is wrong, `groups` will be `[]` — adjust path.

**Step 7: Commit**

```bash
git add dashboard/terminal-dashboard.js
git commit -m "feat(dashboard): add data collectors (groups, service, cpu/mem, agents)"
```

---

## Task 3: Implement service log watcher

**Files:**
- Modify: `dashboard/terminal-dashboard.js`

**Step 1: Add log watcher**

Add after the data collectors:

```js
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
      const stat = fs.fstatSync(fd);
      if (stat.size < _logOffset) _logOffset = 0; // log rotated

      const toRead = stat.size - _logOffset;
      if (toRead <= 0) { fs.closeSync(fd); return; }

      const buf = Buffer.alloc(toRead);
      fs.readSync(fd, buf, 0, toRead, _logOffset);
      fs.closeSync(fd);
      _logOffset += toRead;

      const newLines = buf.toString('utf8').split('\n').filter(Boolean);
      state.serviceLog.push(...newLines);
      if (state.serviceLog.length > 200) state.serviceLog = state.serviceLog.slice(-200);
    } catch { }
  });
}
```

**Step 2: Call it from the entry point**

Add `initLogWatcher();` after `loadGroups();` in the poll loop section.

**Step 3: Update the temp dump to show log**

Change the debug interval to also show the last 5 log lines:
```js
process.stdout.write(state.serviceLog.slice(-5).join('\n') + '\n');
```

**Step 4: Run and verify**

```bash
node dashboard/terminal-dashboard.js
```

Expected: last 5 lines of nanoclaw.log visible. If the file doesn't exist yet, `serviceLog` will be empty — that's fine.

**Step 5: Commit**

```bash
git add dashboard/terminal-dashboard.js
git commit -m "feat(dashboard): add service log watcher"
```

---

## Task 4: Implement JSONL transcript watcher

**Files:**
- Modify: `dashboard/terminal-dashboard.js`

**Step 1: Add transcript parser**

```js
// ── Data: Transcript watcher ──────────────────────────────────────────────────
let _transcriptFile = null;
let _transcriptOffset = 0;
let _transcriptWatching = false;

function parseJsonlEvent(obj) {
  const events = [];
  if (!obj || typeof obj !== 'object') return events;

  if (obj.type === 'user') {
    const raw = typeof obj.message?.content === 'string'
      ? obj.message.content
      : JSON.stringify(obj.message?.content ?? '');
    // Strip XML wrapper if present
    const text = raw.replace(/<messages>[\s\S]*?<message[^>]*>([\s\S]*?)<\/message>[\s\S]*?<\/messages>/g, '$1').trim();
    events.push({ kind: 'user', text });
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
    state.transcriptScroll = 0; // follow mode
  } catch { }
}

function watchTranscript(groupName) {
  const latest = findLatestJsonl(groupName);
  if (!latest) return;

  if (latest.path !== _transcriptFile) {
    // New session — switch files
    if (_transcriptFile) fs.unwatchFile(_transcriptFile);
    _transcriptFile = latest.path;
    _transcriptOffset = 0;
    state.transcript.push({ kind: 'divider', text: '── new session ──' });
    loadTranscript(_transcriptFile);

    fs.watchFile(_transcriptFile, { interval: 500 }, () => {
      try {
        const fd = fs.openSync(_transcriptFile, 'r');
        const stat = fs.fstatSync(fd);
        const toRead = stat.size - _transcriptOffset;
        if (toRead <= 0) { fs.closeSync(fd); return; }
        const buf = Buffer.alloc(toRead);
        fs.readSync(fd, buf, 0, toRead, _transcriptOffset);
        fs.closeSync(fd);
        _transcriptOffset += toRead;

        for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
          try { state.transcript.push(...parseJsonlEvent(JSON.parse(line))); } catch { }
        }
        if (state.transcript.length > 500) state.transcript = state.transcript.slice(-500);
        if (state.transcriptScroll === 0) render(); // re-render in follow mode
      } catch { }
    });
  }
}
```

**Step 2: Call watchTranscript in scanAgents**

At the end of `scanAgents()`, add:
```js
if (state.selectedAgent) watchTranscript(state.selectedAgent);
```

**Step 3: Add a render() stub and call it**

```js
function render() {
  process.stdout.write(CLEAR);
  process.stdout.write(`transcript events: ${state.transcript.length}\n`);
  state.transcript.slice(-5).forEach(ev => {
    process.stdout.write(JSON.stringify(ev) + '\n');
  });
}
```

Replace the debug `setInterval` with:
```js
setInterval(render, 2_000);
```

**Step 4: Run and verify**

```bash
node dashboard/terminal-dashboard.js
```

Expected: transcript events count grows, last 5 events printed as JSON showing `kind: "user"`, `kind: "assistant"`, `kind: "tool_use"`, `kind: "tool_result"`.

If count is 0, the session file may be idle — check `findLatestJsonl('main')` returns a path.

**Step 5: Commit**

```bash
git add dashboard/terminal-dashboard.js
git commit -m "feat(dashboard): add JSONL transcript watcher and parser"
```

---

## Task 5: Implement the full screen renderer

**Files:**
- Modify: `dashboard/terminal-dashboard.js`

This task replaces the stub `render()` with a real full-screen layout: header, agent panel, split pane (transcript + service log), legend.

**Step 1: Add screen dimension helpers**

Before `render()`:
```js
function termSize() {
  return { cols: process.stdout.columns || 120, rows: process.stdout.rows || 40 };
}

function colorize(line) {
  if (/\bERROR\b|\bERR\b/.test(line)) return RED + line + RESET;
  if (/\bWARN\b|\bWARNING\b/.test(line)) return ORANGE + line + RESET;
  if (/\bINFO\b/.test(line)) return line;
  return DIM + line + RESET;
}

function renderBar(value, width, color) {
  const filled = Math.round((value / 100) * width);
  return color + '█'.repeat(filled) + RESET + DIM + '░'.repeat(width - filled) + RESET;
}
```

**Step 2: Replace `render()` with full layout**

```js
function render() {
  const { cols, rows } = termSize();
  const out = [];

  // ── Header (1 line) ─────────────────────────────────────────────────────────
  const statusColor = state.serviceStatus === 'active' ? B_GREEN : RED;
  const statusDot = state.serviceStatus === 'active' ? '●' : '○';
  const agentCount = state.agents.filter(a => a.active).length;
  const header = ` NANOCLAW  ${statusColor}${statusDot} ${state.serviceStatus}${RESET}` +
    `  cpu ${renderBar(state.cpu, 8, CYAN)} ${state.cpu}%` +
    `  mem ${renderBar(state.mem, 8, YELLOW)} ${state.mem}%` +
    `  agents: ${agentCount}  ${BOLD}${now()}${RESET}`;
  out.push(BOX.TL + BOX.H.repeat(cols - 2) + BOX.TR);
  out.push(BOX.V + ' ' + clamp(stripAnsi(header), cols - 3) + ' '.repeat(Math.max(0, cols - 3 - stripAnsiLen(header))) + BOX.V);
  // Note: we need stripAnsi for length calc — implement below

  // ── Agent panel ─────────────────────────────────────────────────────────────
  out.push(BOX.LJ + BOX.H.repeat(cols - 2) + BOX.RJ);
  out.push(BOX.V + BOLD + ' AGENTS' + RESET + ' '.repeat(cols - 9) + BOX.V);
  for (const agent of state.agents) {
    const dot = agent.active ? B_GREEN + '●' + RESET : GRAY + '○' + RESET;
    const nameStr = agent.name.padEnd(12);
    const toolStr = agent.active && agent.currentTool
      ? YELLOW + '► ' + agent.currentTool + RESET
      : GRAY + 'idle' + RESET;
    const ageStr = agent.lastSeen
      ? agent.active
        ? GREEN + 'active' + RESET
        : GRAY + formatAge(agent.lastSeen) + RESET
      : GRAY + 'never' + RESET;
    const line = ` ${dot} ${nameStr} ${toolStr}`;
    const lineLen = 2 + nameStr.length + 2 + stripAnsiLen(toolStr);
    const pad = Math.max(0, cols - lineLen - ageStr.replace(/\x1b\[[^m]*m/g, '').length - 3);
    out.push(BOX.V + line + ' '.repeat(pad) + ageStr + ' ' + BOX.V);
  }

  // ── Split pane divider ──────────────────────────────────────────────────────
  const transcriptCols = Math.floor((cols - 3) * 0.6);
  const logCols = cols - 3 - transcriptCols;
  out.push(BOX.lj + BOX.h.repeat(transcriptCols) + BOX.tj + BOX.h.repeat(logCols) + BOX.rj);

  // ── Pane headers ────────────────────────────────────────────────────────────
  const tHeader = ` TRANSCRIPT  [${state.selectedAgent ?? 'none'}]`;
  const lHeader = ' SERVICE LOG';
  out.push(
    BOX.V + BOLD + tHeader.padEnd(transcriptCols) + RESET +
    BOX.v +
    BOLD + lHeader.padEnd(logCols) + RESET +
    BOX.V
  );

  // ── Pane content ─────────────────────────────────────────────────────────────
  const legendLines = 1;
  const headerLines = out.length;
  const paneRows = rows - headerLines - legendLines - 2; // -2 for bottom border + legend border

  const transcriptLines = renderTranscript(transcriptCols, paneRows);
  const logLines = renderServiceLog(logCols, paneRows);

  for (let i = 0; i < paneRows; i++) {
    const tLine = (transcriptLines[i] ?? '').padEnd(transcriptCols);
    const lLine = (logLines[i] ?? '').padEnd(logCols);
    out.push(BOX.V + tLine + BOX.v + lLine + BOX.V);
  }

  // ── Legend ───────────────────────────────────────────────────────────────────
  out.push(BOX.lj + BOX.h.repeat(transcriptCols) + BOX.bj + BOX.h.repeat(logCols) + BOX.rj);
  const legend = `  ${DIM}[Tab]${RESET} cycle agents  ${DIM}[↑↓]${RESET} scroll  ${DIM}[g]${RESET} follow  ${DIM}[r]${RESET} restart service  ${DIM}[q]${RESET} quit`;
  out.push(BOX.V + legend + ' '.repeat(Math.max(0, cols - 2 - stripAnsiLen(legend))) + BOX.V);
  out.push(BOX.BL + BOX.H.repeat(cols - 2) + BOX.BR);

  process.stdout.write(`${ESC}H` + out.join('\n'));
}

function formatAge(mtime) {
  const sec = Math.floor((Date.now() - mtime) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec/60)}m ago`;
  return `${Math.floor(sec/3600)}h ago`;
}
```

**Step 3: Add stripAnsi helpers**

```js
const ANSI_RE = /\x1b\[[^m]*m/g;
function stripAnsi(str) { return str.replace(ANSI_RE, ''); }
function stripAnsiLen(str) { return stripAnsi(str).length; }
```

**Step 4: Add transcript renderer**

```js
function renderTranscript(width, height) {
  const lines = [];
  for (const ev of state.transcript) {
    switch (ev.kind) {
      case 'divider':
        lines.push(GRAY + ev.text.padEnd(width - 1) + RESET);
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

  // Scroll: 0 = follow (show last N lines), positive = scroll up
  const total = lines.length;
  const start = Math.max(0, total - height - state.transcriptScroll);
  return lines.slice(start, start + height);
}
```

**Step 5: Add service log renderer**

```js
function renderServiceLog(width, height) {
  const lines = state.serviceLog.slice(-height).map(l => {
    const colored = colorize(l);
    return colored.slice(0, width + 20); // allow for ANSI codes
  });
  // Pad to height
  while (lines.length < height) lines.push('');
  return lines;
}
```

**Step 6: Run and verify visually**

```bash
node dashboard/terminal-dashboard.js
```

Expected: Full-screen layout with:
- Header showing service status + bars + time
- Agent panel with group names
- Split pane: transcript left, service log right
- Legend at bottom

Resize your terminal window — layout should adapt to new dimensions on next render cycle.

**Step 7: Commit**

```bash
git add dashboard/terminal-dashboard.js
git commit -m "feat(dashboard): full screen renderer with split pane layout"
```

---

## Task 6: Implement keyboard controls

**Files:**
- Modify: `dashboard/terminal-dashboard.js`

**Step 1: Add keyboard input handler**

After `initLogWatcher()` call, add:

```js
// ── Keyboard input ────────────────────────────────────────────────────────────
if (process.stdin.isTTY) {
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.on('keypress', (str, key) => {
    if (!key) return;

    if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
      cleanup();
    }

    if (key.name === 'tab') {
      // Cycle through all agents
      const names = state.agents.map(a => a.name);
      if (names.length === 0) return;
      const idx = names.indexOf(state.selectedAgent);
      const next = names[(idx + 1) % names.length];
      state.selectedAgent = next;
      _transcriptFile = null;   // force transcript reload for new agent
      state.transcript = [];
      state.transcriptScroll = 0;
      watchTranscript(next);
      render();
    }

    if (key.name === 'up') {
      state.transcriptScroll = Math.min(state.transcriptScroll + 3, Math.max(0, state.transcript.length - 10));
      render();
    }

    if (key.name === 'down') {
      state.transcriptScroll = Math.max(0, state.transcriptScroll - 3);
      render();
    }

    if (key.name === 'g') {
      state.transcriptScroll = 0;
      render();
    }

    if (key.name === 'r') {
      exec('systemctl --user restart nanoclaw', () => {
        checkServiceStatus();
        render();
      });
    }
  });
}
```

**Step 2: Run and test each key**

```bash
node dashboard/terminal-dashboard.js
```

- Press `Tab` → agent name in TRANSCRIPT header changes
- Press `↑` → transcript scrolls up (events shift)
- Press `↓` → transcript scrolls down
- Press `g` → jumps to bottom (follow mode)
- Press `r` → triggers service restart (confirm with `systemctl --user status nanoclaw`)
- Press `q` → exits, cursor restored

**Step 3: Commit**

```bash
git add dashboard/terminal-dashboard.js
git commit -m "feat(dashboard): keyboard controls (Tab, ↑↓, g, r, q)"
```

---

## Task 7: Polish and fix rendering edge cases

**Files:**
- Modify: `dashboard/terminal-dashboard.js`

**Step 1: Fix line-length calculation for ANSI-colored agent panel**

The agent panel currently uses raw string lengths that include ANSI codes, making padding wrong. Replace the agent panel rendering loop with careful `stripAnsiLen` calls:

```js
for (const agent of state.agents) {
  const dot = agent.active ? B_GREEN + '●' + RESET : GRAY + '○' + RESET;
  const name = (agent.name).slice(0, 12).padEnd(12);
  const tool = agent.active && agent.currentTool
    ? YELLOW + '► ' + agent.currentTool.slice(0, 40) + RESET
    : GRAY + 'idle' + RESET;
  const age = agent.lastSeen
    ? (agent.active ? GREEN + 'active' + RESET : GRAY + formatAge(agent.lastSeen) + RESET)
    : GRAY + 'never' + RESET;

  const visibleLen = 1 + 1 + 1 + name.length + 1 + stripAnsiLen(tool) + 1 + stripAnsiLen(age) + 1;
  const pad = Math.max(0, cols - 2 - visibleLen);
  out.push(`${BOX.V} ${dot} ${name} ${tool}${' '.repeat(pad)} ${age} ${BOX.V}`);
}
```

**Step 2: Handle zero-agent case**

If `state.agents` is empty (DB not ready), show a placeholder:

```js
if (state.agents.length === 0) {
  out.push(BOX.V + GRAY + '  no registered groups' + RESET + ' '.repeat(cols - 23) + BOX.V);
}
```

**Step 3: Ensure terminal size is re-read on each render**

`termSize()` already reads `process.stdout.columns` live, so this is automatic. Add a `SIGWINCH` handler to force a re-render:

```js
process.on('SIGWINCH', () => render());
```

**Step 4: Remove the debug polling interval**

The 2s `setInterval(render, ...)` is fine to keep, but remove any remaining `console.log` debug lines.

**Step 5: Run a full smoke test**

```bash
node dashboard/terminal-dashboard.js
```

Walk through:
1. Resize terminal → layout adjusts
2. Tab through agents → transcript reloads
3. Scroll up and down in transcript → works without corruption
4. `g` returns to bottom
5. `q` exits cleanly — cursor visible, terminal not garbled

**Step 6: Commit**

```bash
git add dashboard/terminal-dashboard.js
git commit -m "fix(dashboard): ANSI-aware padding, zero-agent placeholder, SIGWINCH"
```

---

## Task 8: Retire the web dashboard

**Files:**
- Delete: `dashboard/api/`
- Delete: `dashboard/web/`
- Modify: `dashboard/start.sh` (if it starts the API server)
- Modify: `dashboard/start-dashboard.sh`

**Step 1: Check what start scripts do**

```bash
cat dashboard/start.sh
cat dashboard/start-dashboard.sh
cat dashboard/start-headless.sh
```

**Step 2: Delete web and api directories**

```bash
rm -rf dashboard/api dashboard/web
```

**Step 3: Update start scripts**

Replace any script that starts the API server or web dev server with just:

```bash
#!/usr/bin/env bash
node "$(dirname "$0")/terminal-dashboard.js"
```

**Step 4: Verify nothing else references the API server**

```bash
grep -r "localhost:3001\|dashboard/api\|dashboard/web" --include="*.ts" --include="*.js" --include="*.sh" .
```

Remove or update any references found.

**Step 5: Commit**

```bash
git add -A
git commit -m "chore: retire web dashboard (api/ and web/ directories)"
```

---

## Done

The terminal dashboard now:
- Shows agent status panel with active tool call
- Streams Claude session transcript (tool_use, tool_result, assistant messages) in real-time
- Streams nanoclaw.log in a side pane
- Has keyboard controls with visible legend
- Reads all data directly from filesystem — no API server
