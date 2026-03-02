#!/usr/bin/env node
/**
 * Status bar pane: service status, CPU/mem bars, agent count, clock.
 * Redraws every 2s. Outputs 3 lines to fill the tmux pane.
 */
import os from 'os';
import { exec } from 'child_process';
import {
  ESC, RESET, BOLD, DIM, RED, CYAN, YELLOW, B_GREEN, ORANGE,
  now, renderBar, loadGroups, findLatestJsonl,
} from './lib.js';

let serviceStatus = 'unknown';
let cpu = 0;
let mem = 0;
let cpuPrev = null;

function checkService() {
  exec('systemctl --user is-active nanoclaw', (err, stdout) => {
    serviceStatus = stdout.trim() || (err ? 'inactive' : 'unknown');
  });
}

function readStats() {
  const cpus = os.cpus();
  const curr = cpus.reduce((a, c) => {
    const t = Object.values(c.times).reduce((s, v) => s + v, 0);
    return { total: a.total + t, idle: a.idle + c.times.idle };
  }, { total: 0, idle: 0 });
  if (cpuPrev) {
    const dt = curr.total - cpuPrev.total;
    const di = curr.idle - cpuPrev.idle;
    cpu = dt > 0 ? Math.round((1 - di / dt) * 100) : 0;
  }
  cpuPrev = curr;
  mem = Math.round((1 - os.freemem() / os.totalmem()) * 100);
}

function countActiveAgents() {
  const groups = loadGroups();
  const nowMs = Date.now();
  return groups.filter(g => {
    const latest = findLatestJsonl(g.folder ?? g.name);
    return latest && (nowMs - latest.mtime) < 60_000;
  }).length;
}

function render() {
  const cols = process.stdout.columns || 120;
  readStats();

  const statusColor = serviceStatus === 'active' ? B_GREEN : RED;
  const statusDot = serviceStatus === 'active' ? '●' : '○';
  const agentCount = countActiveAgents();

  const left = `${BOLD}${ORANGE} NANOCLAW${RESET}  ${statusColor}${statusDot} ${serviceStatus}${RESET}` +
    `  cpu ${renderBar(cpu, 8, CYAN)}${String(cpu).padStart(3)}%` +
    `  mem ${renderBar(mem, 8, YELLOW)}${String(mem).padStart(3)}%` +
    `  agents:${agentCount}`;

  const right = `${DIM}q${RESET}:quit  ${BOLD}${now()}${RESET} `;

  process.stdout.write(`${ESC}H${ESC}2J${left}${right}`);
}

checkService();
render();
setInterval(checkService, 5_000);
setInterval(render, 2_000);
