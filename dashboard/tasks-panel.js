#!/usr/bin/env node
/**
 * Scheduled tasks pane: shows active tasks grouped by group with human-readable times.
 */
import {
  ESC, RESET, BOLD, DIM, GRAY, CYAN, GREEN, YELLOW,
  loadTasks, formatTime, relativeTime,
} from './lib.js';

function render() {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 20;
  const tasks = loadTasks();

  const header = `${BOLD} SCHEDULED TASKS${RESET}  ${DIM}(${tasks.length} active)${RESET}`;
  const lines = [];

  // Group by group_folder
  const grouped = {};
  for (const t of tasks) {
    const key = t.group_folder || 'unknown';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(t);
  }

  for (const [group, gTasks] of Object.entries(grouped)) {
    lines.push(`${CYAN}${BOLD}${group}${RESET}`);
    for (const t of gTasks) {
      const prompt = (t.prompt || '').slice(0, cols - 30);
      const schedule = t.schedule_type === 'cron'
        ? `${DIM}cron: ${t.schedule_value}${RESET}`
        : `${DIM}${t.schedule_type}: ${t.schedule_value}${RESET}`;
      const nextRun = t.next_run
        ? `${GREEN}next: ${formatTime(t.next_run)} ${GRAY}(${relativeTime(t.next_run)})${RESET}`
        : `${GRAY}next: --${RESET}`;
      const lastRun = t.last_run
        ? `${DIM}last: ${formatTime(t.last_run)} (${relativeTime(t.last_run)})${RESET}`
        : '';

      lines.push(`  ${YELLOW}${prompt}${RESET}`);
      lines.push(`    ${schedule}  ${nextRun}${lastRun ? `  ${lastRun}` : ''}`);
    }
    lines.push('');
  }

  if (tasks.length === 0) {
    lines.push(`  ${GRAY}no scheduled tasks${RESET}`);
  }

  const visibleRows = rows - 1;
  const visible = lines.slice(0, visibleRows);
  while (visible.length < visibleRows) visible.push('');

  process.stdout.write(`${ESC}H${ESC}2J${header}\n${visible.join('\n')}`);
}

render();
setInterval(render, 5_000);
