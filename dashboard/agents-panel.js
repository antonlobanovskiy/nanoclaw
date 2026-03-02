#!/usr/bin/env node
/**
 * Agent list pane: single-row horizontal display of all agents with status.
 * Auto-selects the most recently active agent and writes to /tmp/nc-dash-agent.
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import {
  ESC, RESET, BOLD, DIM, GRAY, GREEN, B_GREEN,
  loadGroups, findLatestJsonl, formatAge, AGENT_FILE, BASE,
} from './lib.js';

let agents = [];
let selectedName = null;
let manualSelection = false;

function scanAgents() {
  const groups = loadGroups();
  const nowMs = Date.now();
  agents = groups.map(g => {
    const name = g.folder ?? g.name;
    const latest = findLatestJsonl(name);
    const active = latest && (nowMs - latest.mtime) < 60_000;
    const lastSeen = latest ? latest.mtime : null;
    let model = null;
    try {
      const raw = fs.readFileSync(path.join(BASE, 'data', 'ipc', name, 'model.txt'), 'utf8').trim();
      model = raw.replace('claude-', '').replace('-4-6', '');
    } catch { }
    return { name, active, lastSeen, model };
  });

  if (!manualSelection) {
    const sorted = [...agents].filter(a => a.active).sort((a, b) => b.lastSeen - a.lastSeen);
    if (sorted.length > 0) {
      selectedName = sorted[0].name;
    } else if (!selectedName && agents.length > 0) {
      selectedName = agents[0].name;
    }
  }

  if (selectedName) {
    try { fs.writeFileSync(AGENT_FILE, selectedName); } catch { }
  }
}

function render() {
  const parts = [];
  for (const a of agents) {
    const sel = a.name === selectedName ? '▸' : ' ';
    const dot = a.active ? `${B_GREEN}●${RESET}` : `${GRAY}○${RESET}`;
    const name = a.name;
    const age = a.lastSeen
      ? (a.active ? `${GREEN}active${RESET}` : `${GRAY}${formatAge(a.lastSeen)}${RESET}`)
      : `${GRAY}never${RESET}`;
    const modelTag = a.model ? ` ${DIM}${a.model}${RESET}` : '';
    parts.push(`${sel}${dot} ${BOLD}${name}${RESET} ${age}${modelTag}`);
  }

  const line = agents.length > 0
    ? ` ${parts.join('   ')}`
    : ` ${GRAY}no registered groups${RESET}`;

  process.stdout.write(`${ESC}H${ESC}2J${line}`);
}

// ── Keyboard: Tab to cycle ───────────────────────────────────────────────────
if (process.stdin.isTTY) {
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.on('keypress', (_str, key) => {
    if (!key) return;
    if (key.name === 'tab' && agents.length > 0) {
      const idx = agents.findIndex(a => a.name === selectedName);
      selectedName = agents[(idx + 1) % agents.length].name;
      manualSelection = true;
      try { fs.writeFileSync(AGENT_FILE, selectedName); } catch { }
      render();
    }
  });
}

scanAgents();
render();
setInterval(scanAgents, 2_000);
setInterval(render, 2_000);
