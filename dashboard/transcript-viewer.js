#!/usr/bin/env node
/**
 * Transcript viewer pane: JSONL parser + colorizer for selected agent.
 * Watches /tmp/nc-dash-agent for agent selection changes.
 * Up/Down to scroll, g to follow (jump to bottom).
 */
import fs from 'fs';
import path from 'path';
import {
  ESC, RESET, BOLD, DIM, GRAY, GREEN, CYAN, YELLOW,
  findLatestJsonl, parseJsonlEvent, AGENT_FILE, BASE,
} from './lib.js';

let selectedAgent = null;
let transcript = [];
let watchedFile = null;
let watchedOffset = 0;
let currentModel = null;

function readAgentModel(groupName) {
  if (!groupName) return null;
  try {
    const modelFile = path.join(BASE, 'data', 'ipc', groupName, 'model.txt');
    return fs.readFileSync(modelFile, 'utf8').trim();
  } catch {
    return null;
  }
}

// ── Agent selection polling ──────────────────────────────────────────────────
function pollAgentSelection() {
  try {
    const name = fs.readFileSync(AGENT_FILE, 'utf8').trim();
    if (name && name !== selectedAgent) {
      selectedAgent = name;
      currentModel = readAgentModel(name);
      transcript = [];
      unwatchTranscript();
      watchTranscript(name);
      render();
    }
  } catch { }
}

// ── Transcript watching ──────────────────────────────────────────────────────
function unwatchTranscript() {
  if (watchedFile) {
    fs.unwatchFile(watchedFile);
    watchedFile = null;
    watchedOffset = 0;
  }
}

function loadFull(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    watchedOffset = Buffer.byteLength(content, 'utf8');
    transcript = [];
    for (const line of content.split('\n').filter(Boolean)) {
      try { transcript.push(...parseJsonlEvent(JSON.parse(line))); } catch { }
    }
    if (transcript.length > 500) transcript = transcript.slice(-500);
  } catch { }
}

function watchTranscript(groupName) {
  const latest = findLatestJsonl(groupName);
  if (!latest) return;

  watchedFile = latest.path;
  loadFull(watchedFile);

  fs.watchFile(watchedFile, { interval: 500 }, () => {
    try {
      const fd = fs.openSync(watchedFile, 'r');
      try {
        const stat = fs.fstatSync(fd);
        const toRead = stat.size - watchedOffset;
        if (toRead > 0) {
          const buf = Buffer.alloc(toRead);
          fs.readSync(fd, buf, 0, toRead, watchedOffset);
          watchedOffset += toRead;
          for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
            try { transcript.push(...parseJsonlEvent(JSON.parse(line))); } catch { }
          }
          if (transcript.length > 500) transcript = transcript.slice(-500);
          render();
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch { }
  });
}

// ── Rendering ────────────────────────────────────────────────────────────────
function render() {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 30;

  const header = `${BOLD} TRANSCRIPT${RESET}  ${DIM}[${selectedAgent ?? 'none'}]${RESET}`;
  const allLines = [];

  for (const ev of transcript) {
    switch (ev.kind) {
      case 'divider':
        allLines.push(`${GRAY}${ev.text.slice(0, cols - 1)}${RESET}`);
        break;
      case 'user':
        allLines.push(`${CYAN}${BOLD}[user]${RESET}`);
        for (const l of ev.text.split('\n').slice(0, 10))
          allLines.push(`  ${l.slice(0, cols - 3)}`);
        allLines.push('');
        break;
      case 'assistant': {
        const modelTag = currentModel
          ? currentModel.replace('claude-', '').replace('-4-6', '')
          : null;
        allLines.push(`${GREEN}${BOLD}[assistant${modelTag ? ` · ${modelTag}` : ''}]${RESET}`);
        for (const l of ev.text.split('\n').slice(0, 15))
          allLines.push(`  ${l.slice(0, cols - 3)}`);
        allLines.push('');
        break;
      }
      case 'tool_use':
        allLines.push(`${YELLOW}${BOLD}[tool_use] ${ev.name}${RESET}`);
        for (const l of ev.inputLines ?? [])
          allLines.push(l.slice(0, cols - 1));
        allLines.push('');
        break;
      case 'tool_result':
        allLines.push(`${DIM}[tool_result]${RESET}`);
        for (const l of ev.lines ?? [])
          allLines.push(`${DIM}${l.slice(0, cols - 1)}${RESET}`);
        allLines.push('');
        break;
    }
  }

  const visibleRows = rows - 1; // 1 for header
  const total = allLines.length;
  const start = Math.max(0, total - visibleRows);
  const visible = allLines.slice(start, start + visibleRows);

  // Pad to fill pane
  while (visible.length < visibleRows) visible.push('');

  process.stdout.write(`${ESC}H${ESC}2J${header}\n${visible.join('\n')}`);
}

// ── Init ─────────────────────────────────────────────────────────────────────
pollAgentSelection();
setInterval(pollAgentSelection, 500);
setInterval(() => {
  if (selectedAgent) currentModel = readAgentModel(selectedAgent);
  render();
}, 2_000);
render();
