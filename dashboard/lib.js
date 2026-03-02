/**
 * Shared utilities for NanoClaw dashboard panes.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// ── Paths ────────────────────────────────────────────────────────────────────
export const HOME = os.homedir();
export const BASE = path.join(HOME, 'dev/NanoClaw');
export const DB_PATH = path.join(BASE, 'store/messages.db');
export const LOG_PATH = path.join(BASE, 'logs/nanoclaw.log');
export const SESSIONS_DIR = path.join(BASE, 'data/sessions');
export const AGENT_FILE = '/tmp/nc-dash-agent';

// ── ANSI ─────────────────────────────────────────────────────────────────────
export const ESC = '\x1b[';
export const RESET = `${ESC}0m`;
export const BOLD = `${ESC}1m`;
export const DIM = `${ESC}2m`;
export const RED = `${ESC}31m`;
export const GREEN = `${ESC}32m`;
export const YELLOW = `${ESC}33m`;
export const CYAN = `${ESC}36m`;
export const WHITE = `${ESC}37m`;
export const GRAY = `${ESC}90m`;
export const ORANGE = `${ESC}38;5;208m`;
export const B_GREEN = `${ESC}92m`;

const ANSI_RE = /\x1b\[[^m]*m/g;
export function stripAnsi(str) { return str.replace(ANSI_RE, ''); }
export function stripAnsiLen(str) { return stripAnsi(str).length; }

// ── Helpers ──────────────────────────────────────────────────────────────────
export function now() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

export function formatAge(mtime) {
  const sec = Math.floor((Date.now() - mtime) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

export function renderBar(value, width, color) {
  const filled = Math.round(Math.max(0, Math.min(100, value)) / 100 * width);
  return color + '█'.repeat(filled) + RESET + DIM + '░'.repeat(width - filled) + RESET;
}

// ── Data ─────────────────────────────────────────────────────────────────────
export function loadGroups() {
  try {
    const Database = require(path.join(BASE, 'node_modules/better-sqlite3'));
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    const groups = db.prepare('SELECT name, folder FROM registered_groups').all();
    db.close();
    return groups;
  } catch {
    return [];
  }
}

export function findLatestJsonl(groupName) {
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

export function getLastToolCall(jsonlPath) {
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

export function parseJsonlEvent(obj) {
  const events = [];
  if (!obj || typeof obj !== 'object') return events;

  if (obj.type === 'user') {
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
