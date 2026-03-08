#!/usr/bin/env node
/**
 * Input prompt: triggered by 'i' key in tmux dashboard.
 * Opens a tmux command prompt to get user input, then POSTs to dashboard API.
 */
import fs from 'fs';
import http from 'http';
import { execSync } from 'child_process';
import { AGENT_FILE } from './lib.js';

const agent = (() => {
  try { return fs.readFileSync(AGENT_FILE, 'utf8').trim(); } catch { return null; }
})();

if (!agent) {
  execSync(`tmux display-message "No agent selected"`);
  process.exit(0);
}

// Use tmux command-prompt to get input from user
try {
  execSync(
    `tmux command-prompt -p "msg(${agent}):" ` +
    `"run-shell \\"node '${import.meta.dirname}/send-message.js' '${agent}' '%1'\\""`,
    { stdio: 'inherit' }
  );
} catch { }
