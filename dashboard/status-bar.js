#!/usr/bin/env node
/**
 * Status bar pane: service status, CPU/mem bars, container/subagent counts, clock.
 */
import os from 'os';
import { exec } from 'child_process';
import {
  ESC, RESET, BOLD, DIM, RED, CYAN, YELLOW, B_GREEN, ORANGE, PURPLE,
  now, renderBar, loadGroups, loadContainers, findLatestJsonl, countSubagents,
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

function render() {
  readStats();
  const containers = loadContainers();
  const groups = loadGroups();

  // Count subagents across running containers
  let totalSubagents = 0;
  for (const g of groups) {
    const folder = g.folder ?? g.name;
    const hasContainer = containers.some(c => c.name?.startsWith(`nanoclaw-${folder}-`));
    if (hasContainer) {
      const latest = findLatestJsonl(folder);
      if (latest) totalSubagents += countSubagents(latest.path).active;
    }
  }

  const statusColor = serviceStatus === 'active' ? B_GREEN : RED;
  const statusDot = serviceStatus === 'active' ? '●' : '○';

  const left = `${BOLD}${ORANGE} NANOCLAW${RESET}  ${statusColor}${statusDot} ${serviceStatus}${RESET}` +
    `  cpu ${renderBar(cpu, 8, CYAN)}${String(cpu).padStart(3)}%` +
    `  mem ${renderBar(mem, 8, YELLOW)}${String(mem).padStart(3)}%` +
    `  containers:${containers.length}` +
    (totalSubagents > 0 ? `  ${PURPLE}subagents:${totalSubagents}${RESET}` : '');

  const right = `${DIM}tab${RESET}:cycle  ${DIM}i${RESET}:input  ${DIM}q${RESET}:quit  ${BOLD}${now()}${RESET} `;

  process.stdout.write(`${ESC}H${ESC}2J${left}${right}`);
}

checkService();
render();
setInterval(checkService, 5_000);
setInterval(render, 2_000);
