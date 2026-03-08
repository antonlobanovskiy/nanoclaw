#!/usr/bin/env node
/**
 * NanoClaw Terminal Monitor
 * Reads data directly from filesystem — no API server dependency.
 *
 * Controls: Tab=cycle agents  ↑↓=scroll  g=follow  r=restart  i=input  q=quit
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { exec, execSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// ── Paths ────────────────────────────────────────────────────────────────────
const HOME = os.homedir();
const BASE = path.join(HOME, 'dev/NanoClaw');
const DB_PATH = path.join(BASE, 'store/messages.db');
const LOG_PATH = path.join(BASE, 'logs/nanoclaw.log');
const SESSIONS_DIR = path.join(BASE, 'data/sessions');

// ── ANSI ─────────────────────────────────────────────────────────────────────
const ESC = '\x1b[';
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const RED = `${ESC}31m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const CYAN = `${ESC}36m`;
const GRAY = `${ESC}90m`;
const ORANGE = `${ESC}38;5;208m`;
const B_GREEN = `${ESC}92m`;
const PURPLE = `${ESC}38;5;183m`;

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
  containers: [],
  tasks: [],
  selectedAgent: null,
  transcript: [],
  transcriptScroll: 0,
  serviceLog: [],
  serviceStatus: 'unknown',
  cpu: 0,
  mem: 0,
  inputMode: false,
  inputText: '',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function clamp(str, width) {
  if (str.length > width) return str.slice(0, width - 1) + '…';
  return str.padEnd(width);
}

function now() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

function formatAge(mtime) {
  const sec = Math.floor((Date.now() - mtime) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

function formatTime(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function relativeTime(iso) {
  if (!iso) return '--';
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const sec = Math.floor(abs / 1000);
  if (sec < 60) return diff > 0 ? `in ${sec}s` : `${sec}s ago`;
  if (sec < 3600) return diff > 0 ? `in ${Math.floor(sec / 60)}m` : `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return diff > 0 ? `in ${Math.floor(sec / 3600)}h` : `${Math.floor(sec / 3600)}h ago`;
  return diff > 0 ? `in ${Math.floor(sec / 86400)}d` : `${Math.floor(sec / 86400)}d ago`;
}

// ── Data: Registered groups + tasks ──────────────────────────────────────────
function loadGroups() {
  try {
    const Database = require(path.join(BASE, 'node_modules/better-sqlite3'));
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    state.groups = db.prepare(`
      SELECT rg.name, rg.folder, rg.is_main as isMain,
             c.last_message_time as lastActivity, c.channel
      FROM registered_groups rg
      LEFT JOIN chats c ON rg.jid = c.jid
      ORDER BY c.last_message_time DESC
    `).all();
    state.tasks = db.prepare(`
      SELECT id, group_folder, prompt, schedule_type, schedule_value,
             next_run, last_run, status
      FROM scheduled_tasks
      WHERE status = 'active'
      ORDER BY next_run
    `).all();
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

// ── Data: Docker containers ──────────────────────────────────────────────────
function loadContainers() {
  exec('docker ps --filter name=nanoclaw- --format "{{json .}}"', { timeout: 5000 }, (err, stdout) => {
    if (err) { state.containers = []; return; }
    state.containers = stdout.trim().split('\n').filter(Boolean).map(line => {
      try {
        const c = JSON.parse(line);
        return { name: c.Names, status: c.Status };
      } catch { return null; }
    }).filter(Boolean);
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

// ── Data: Agent activity + subagent counting ─────────────────────────────────
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

function countSubagents(jsonlPath) {
  try {
    const content = fs.readFileSync(jsonlPath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    let spawned = new Set();
    let finished = new Set();

    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        // Reset on new user prompt
        if (ev.type === 'user' && !ev.toolUseResult) {
          const mc = ev.message?.content;
          const isToolResult = Array.isArray(mc) && mc.length > 0 && mc[0]?.type === 'tool_result';
          if (!isToolResult) { spawned = new Set(); finished = new Set(); }
        }
        if (ev.type === 'assistant') {
          const blocks = ev.message?.content || [];
          if (Array.isArray(blocks)) {
            for (const b of blocks) {
              if (b.type === 'tool_use' && b.name === 'Task' && b.id) spawned.add(b.id);
            }
          }
        }
        if (ev.type === 'user' && ev.toolUseResult) {
          const task = ev.toolUseResult.task || ev.toolUseResult;
          const status = task?.status || ev.toolUseResult.status;
          const mc = ev.message?.content;
          if (Array.isArray(mc)) {
            for (const c of mc) {
              if (c.tool_use_id && spawned.has(c.tool_use_id) && (status === 'completed' || status === 'error')) {
                finished.add(c.tool_use_id);
              }
            }
          }
        }
      } catch { }
    }
    return { active: spawned.size - finished.size, total: spawned.size };
  } catch {
    return { active: 0, total: 0 };
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
    const folder = g.folder ?? g.name;
    const latest = findLatestJsonl(folder);
    const container = state.containers.find(c => c.name?.startsWith(`nanoclaw-${folder}-`));
    const containerRunning = !!container;
    const currentTool = containerRunning && latest ? getLastToolCall(latest.path) : null;
    const lastSeen = latest ? latest.mtime : null;
    const subagents = containerRunning && latest ? countSubagents(latest.path) : { active: 0, total: 0 };
    return {
      name: folder,
      displayName: g.name || folder,
      containerRunning,
      containerStatus: container?.status || null,
      currentTool,
      lastSeen,
      lastActivity: g.lastActivity,
      channel: g.channel,
      isMain: g.isMain,
      subagents,
    };
  });

  // Auto-select most recently active agent
  const activeAgents = state.agents.filter(a => a.containerRunning).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  if (activeAgents.length > 0 && !state.agents.find(a => a.name === state.selectedAgent && a.containerRunning)) {
    state.selectedAgent = activeAgents[0].name;
  } else if (!state.selectedAgent && state.agents.length > 0) {
    state.selectedAgent = state.agents[0].name;
  }
  if (state.selectedAgent) watchTranscript(state.selectedAgent);
}

// ── Data: Service log watcher ─────────────────────────────────────────────────
let _logOffset = 0;

function initLogWatcher() {
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
        if (stat.size < _logOffset) _logOffset = 0;
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
    // Check for subagent result first
    const tr = obj.toolUseResult;
    if (tr && (tr.status || tr.task)) {
      const task = tr.task || tr;
      const status = task.status || tr.status || 'unknown';
      const desc = task.description || (tr.prompt || '').slice(0, 60);
      const output = task.output ? task.output.slice(0, 150) : '';
      events.push({ kind: 'subagent_result', status, desc, output });
      return events;
    }

    const raw = typeof obj.message?.content === 'string'
      ? obj.message.content
      : JSON.stringify(obj.message?.content ?? '');
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
        if (c.name === 'Task') {
          const desc = c.input?.description || (c.input?.prompt || '').slice(0, 80);
          events.push({ kind: 'subagent_spawn', desc, prompt: (c.input?.prompt || '').slice(0, 150) });
        } else {
          const inputLines = typeof c.input === 'object'
            ? Object.entries(c.input).map(([k, v]) => `  ${k}: ${String(v).slice(0, 200)}`)
            : [`  ${String(c.input).slice(0, 200)}`];
          events.push({ kind: 'tool_use', name: c.name, inputLines });
        }
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
process.stdout.write(HIDE_CURSOR + '\x1b[?1049h');

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
loadContainers();
scanAgents();

setInterval(loadGroups, 10_000);
setInterval(checkServiceStatus, 5_000);
setInterval(readSystemStats, 2_000);
setInterval(loadContainers, 3_000);
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
      case 'subagent_spawn':
        lines.push(PURPLE + BOLD + `[subagent spawn] ${(ev.desc || '').slice(0, width - 20)}` + RESET);
        if (ev.prompt) {
          lines.push('  ' + DIM + ev.prompt.slice(0, width - 3) + RESET);
        }
        lines.push('');
        break;
      case 'subagent_result': {
        const statusColor = ev.status === 'completed' ? GREEN : ev.status === 'error' ? RED : YELLOW;
        lines.push(PURPLE + `[subagent ${statusColor}${ev.status}${PURPLE}] ${(ev.desc || '').slice(0, width - 25)}` + RESET);
        if (ev.output) {
          lines.push('  ' + DIM + ev.output.slice(0, width - 3) + RESET);
        }
        lines.push('');
        break;
      }
    }
  }
  const total = lines.length;
  const start = Math.max(0, total - height - state.transcriptScroll);
  return lines.slice(start, start + height);
}

function renderServiceLog(width, height) {
  const lines = state.serviceLog.slice(-height).map(l => {
    const truncated = l.slice(0, width);
    return colorizeLog(truncated);
  });
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
  const containerCount = state.containers.length;
  const totalSubagents = state.agents.reduce((s, a) => s + (a.containerRunning ? a.subagents.active : 0), 0);
  const headerContent = ` NANOCLAW  ${statusColor}${statusDot} ${state.serviceStatus}${RESET}` +
    `  cpu ${renderBar(state.cpu, 8, CYAN)} ${state.cpu}%` +
    `  mem ${renderBar(state.mem, 8, YELLOW)} ${state.mem}%` +
    `  containers: ${containerCount}` +
    (totalSubagents > 0 ? `  ${PURPLE}subagents: ${totalSubagents}${RESET}` : '') +
    `  ${BOLD}${now()}${RESET}`;
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
      const selected = agent.name === state.selectedAgent;
      const dot = agent.containerRunning ? B_GREEN + '●' + RESET : GRAY + '○' + RESET;
      const sel = selected ? CYAN + '▸' + RESET : ' ';
      const nameStr = agent.displayName.slice(0, 20).padEnd(20);
      const mainTag = agent.isMain ? DIM + '(main)' + RESET : '';

      // Container status
      const containerStr = agent.containerRunning
        ? GREEN + 'running' + RESET + DIM + ` (${agent.containerStatus || ''})` + RESET
        : GRAY + 'idle' + RESET;

      // Subagents
      const subStr = agent.containerRunning && agent.subagents.active > 0
        ? PURPLE + ` ${agent.subagents.active} subagent${agent.subagents.active > 1 ? 's' : ''}` + RESET
        : '';

      // Last used
      const lastUsed = agent.lastActivity
        ? GRAY + `last used ${relativeTime(agent.lastActivity)}` + RESET
        : GRAY + 'never' + RESET;

      // Current tool
      const tool = agent.containerRunning && agent.currentTool
        ? YELLOW + '► ' + agent.currentTool.slice(0, 35) + RESET
        : '';

      const line1 = ` ${sel}${dot} ${nameStr} ${mainTag} ${containerStr}${subStr}  ${lastUsed}`;
      const line1Pad = Math.max(0, cols - 2 - stripAnsiLen(line1));
      out.push(BOX.V + line1 + ' '.repeat(line1Pad) + BOX.V);

      if (tool) {
        const toolLine = `      ${tool}`;
        const toolPad = Math.max(0, cols - 2 - stripAnsiLen(toolLine));
        out.push(BOX.V + toolLine + ' '.repeat(toolPad) + BOX.V);
      }
    }
  }

  // ── Scheduled Tasks ─────────────────────────────────────────────────────────
  const activeTasks = state.tasks.filter(t => t.status === 'active');
  if (activeTasks.length > 0) {
    out.push(BOX.lj + BOX.h.repeat(cols - 2) + BOX.rj);
    const tasksLabel = ' SCHEDULED TASKS';
    out.push(BOX.V + BOLD + tasksLabel + RESET + ' '.repeat(cols - 2 - tasksLabel.length) + BOX.V);

    // Group by group_folder
    const byGroup = {};
    for (const t of activeTasks) {
      const folder = t.group_folder || 'unknown';
      if (!byGroup[folder]) byGroup[folder] = [];
      byGroup[folder].push(t);
    }

    for (const [folder, tasks] of Object.entries(byGroup)) {
      const groupName = state.groups.find(g => g.folder === folder)?.name || folder;
      const groupLine = `  ${CYAN}${groupName}${RESET}`;
      const groupPad = Math.max(0, cols - 2 - stripAnsiLen(groupLine));
      out.push(BOX.V + groupLine + ' '.repeat(groupPad) + BOX.V);

      for (const t of tasks) {
        const prompt = (t.prompt || t.id || 'task').slice(0, 25);
        const schedule = t.schedule_value || '';
        const nextTime = t.next_run ? `${formatTime(t.next_run)} (${relativeTime(t.next_run)})` : '--';
        const lastTime = t.last_run ? formatTime(t.last_run) : '--';
        const taskLine = `    ${DIM}${schedule.padEnd(18)}${RESET} ${prompt.padEnd(27)} ${DIM}next:${RESET} ${nextTime}`;
        const taskPad = Math.max(0, cols - 2 - stripAnsiLen(taskLine));
        out.push(BOX.V + taskLine + ' '.repeat(taskPad) + BOX.V);
      }
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

  const inputRows = state.inputMode ? 1 : 0;
  const legendRows = 1;
  const fixedRows = out.length + legendRows + inputRows + 2;
  const paneRows = Math.max(1, rows - fixedRows);

  const transcriptLines = renderTranscript(transcriptCols, paneRows);
  const logLines = renderServiceLog(logCols, paneRows);

  for (let i = 0; i < paneRows; i++) {
    const tRaw = transcriptLines[i] ?? '';
    const lRaw = logLines[i] ?? '';
    const tPad = Math.max(0, transcriptCols - stripAnsiLen(tRaw));
    const lPad = Math.max(0, logCols - stripAnsiLen(lRaw));
    out.push(BOX.V + tRaw + ' '.repeat(tPad) + BOX.v + lRaw + ' '.repeat(lPad) + BOX.V);
  }

  // ── Input bar ────────────────────────────────────────────────────────────────
  if (state.inputMode) {
    out.push(BOX.lj + BOX.h.repeat(cols - 2) + BOX.rj);
    const prompt = ` ${CYAN}>${RESET} ${state.inputText}`;
    const cursor = '█';
    const inputLine = prompt + cursor;
    const inputPad = Math.max(0, cols - 2 - stripAnsiLen(inputLine));
    out.push(BOX.V + inputLine + ' '.repeat(inputPad) + BOX.V);
  }

  // ── Legend ────────────────────────────────────────────────────────────────────
  out.push(BOX.lj + BOX.h.repeat(cols - 2) + BOX.rj);
  const legend = state.inputMode
    ? `  ${DIM}[Enter]${RESET} send  ${DIM}[Esc]${RESET} cancel`
    : `  ${DIM}[Tab]${RESET} cycle  ${DIM}[↑↓]${RESET} scroll  ${DIM}[g]${RESET} follow  ${DIM}[i]${RESET} input  ${DIM}[r]${RESET} restart  ${DIM}[q]${RESET} quit`;
  const legendPad = Math.max(0, cols - 2 - stripAnsiLen(legend));
  out.push(BOX.V + legend + ' '.repeat(legendPad) + BOX.V);
  out.push(BOX.BL + BOX.H.repeat(cols - 2) + BOX.BR);

  process.stdout.write(`${ESC}H` + out.join('\n'));

  // Show cursor in input mode
  if (state.inputMode) {
    process.stdout.write(SHOW_CURSOR);
  } else {
    process.stdout.write(HIDE_CURSOR);
  }
}

// ── Send message via dashboard API ──────────────────────────────────────────
function sendMessage(folder, text) {
  const body = JSON.stringify({ text });
  exec(`curl -s -X POST -H 'Content-Type: application/json' -d '${body.replace(/'/g, "'\\''")}' http://localhost:3000/api/groups/${encodeURIComponent(folder)}/send`, { timeout: 5000 }, (err) => {
    if (err) {
      state.serviceLog.push(`[dashboard] Failed to send message: ${err.message}`);
    }
  });
}

// ── Keyboard input ────────────────────────────────────────────────────────────
if (process.stdin.isTTY) {
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.on('keypress', (str, key) => {
    if (!key) return;

    // Input mode handling
    if (state.inputMode) {
      if (key.name === 'escape') {
        state.inputMode = false;
        state.inputText = '';
        render();
        return;
      }
      if (key.name === 'return') {
        const text = state.inputText.trim();
        if (text && state.selectedAgent) {
          sendMessage(state.selectedAgent, text);
        }
        state.inputMode = false;
        state.inputText = '';
        render();
        return;
      }
      if (key.name === 'backspace') {
        state.inputText = state.inputText.slice(0, -1);
        render();
        return;
      }
      if (str && !key.ctrl && !key.meta) {
        state.inputText += str;
        render();
      }
      return;
    }

    if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
      cleanup();
    }

    if (key.name === 'i') {
      if (state.selectedAgent) {
        state.inputMode = true;
        state.inputText = '';
        render();
      }
    }

    if (key.name === 'tab') {
      const names = state.agents.map(a => a.name);
      if (names.length === 0) return;
      const idx = names.indexOf(state.selectedAgent);
      const next = names[(idx + 1) % names.length];
      state.selectedAgent = next;
      _transcriptFile = null;
      state.transcript = [];
      state.transcriptScroll = 0;
      watchTranscript(next);
      render();
    }

    if (key.name === 'up') {
      const { rows } = termSize();
      const maxScroll = Math.max(0, state.transcript.length * 4 - rows);
      state.transcriptScroll = Math.min(state.transcriptScroll + 3, maxScroll);
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

process.on('SIGWINCH', () => render());

setInterval(render, 2_000);
render();
