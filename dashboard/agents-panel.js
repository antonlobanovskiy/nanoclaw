#!/usr/bin/env node
/**
 * Agent list pane: shows all agents with container status, subagents, last used.
 * Auto-selects the most recently active agent and writes to /tmp/nc-dash-agent.
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import {
  ESC, RESET, BOLD, DIM, GRAY, GREEN, B_GREEN, CYAN, PURPLE,
  loadGroups, loadContainers, findLatestJsonl, countSubagents,
  formatAge, relativeTime, AGENT_FILE, BASE,
} from './lib.js';

let agents = [];
let selectedName = null;
let manualSelection = false;

function scanAgents() {
  const groups = loadGroups();
  const containers = loadContainers();
  const nowMs = Date.now();

  agents = groups.map(g => {
    const name = g.folder ?? g.name;
    const latest = findLatestJsonl(name);
    const container = containers.find(c => c.name?.startsWith(`nanoclaw-${name}-`));
    const containerRunning = !!container;
    const subagents = containerRunning && latest ? countSubagents(latest.path) : { active: 0, total: 0 };

    let model = null;
    try {
      const raw = fs.readFileSync(path.join(BASE, 'data', 'ipc', name, 'model.txt'), 'utf8').trim();
      model = raw.replace('claude-', '').replace('-4-6', '');
    } catch { }

    return {
      name,
      displayName: g.name || name,
      containerRunning,
      containerStatus: container?.status || null,
      lastActivity: g.lastActivity,
      isMain: g.isMain,
      model,
      subagents,
    };
  });

  if (!manualSelection) {
    const sorted = [...agents].filter(a => a.containerRunning).sort((a, b) => {
      const aTime = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
      const bTime = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
      return bTime - aTime;
    });
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
  const cols = process.stdout.columns || 120;
  const parts = [];

  for (const a of agents) {
    const sel = a.name === selectedName ? `${CYAN}▸${RESET}` : ' ';
    const dot = a.containerRunning ? `${B_GREEN}●${RESET}` : `${GRAY}○${RESET}`;
    const nameStr = `${BOLD}${a.name}${RESET}`;

    // Container status
    const cStatus = a.containerRunning
      ? `${GREEN}running${RESET}`
      : `${GRAY}idle${RESET}`;

    // Last used
    const lastUsed = a.lastActivity
      ? `${GRAY}${relativeTime(a.lastActivity)}${RESET}`
      : `${GRAY}never${RESET}`;

    // Subagents
    const subStr = a.containerRunning && a.subagents.active > 0
      ? ` ${PURPLE}${a.subagents.active}sub${RESET}`
      : '';

    // Model
    const modelTag = a.model ? ` ${DIM}${a.model}${RESET}` : '';

    parts.push(`${sel}${dot} ${nameStr} ${cStatus}${subStr} ${lastUsed}${modelTag}`);
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
setInterval(scanAgents, 3_000);
setInterval(render, 2_000);
