#!/usr/bin/env node
/**
 * Sends a message to an agent via the dashboard API.
 * Usage: node send-message.js <agent-folder> <message text>
 */
import http from 'http';
import { execSync } from 'child_process';

const folder = process.argv[2];
const text = process.argv.slice(3).join(' ');

if (!folder || !text) process.exit(1);

const body = JSON.stringify({ text });
const req = http.request({
  hostname: '127.0.0.1',
  port: 3000,
  path: `/api/groups/${encodeURIComponent(folder)}/send`,
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const result = JSON.parse(data);
      if (result.ok) {
        execSync(`tmux display-message "Sent to ${folder}"`);
      } else {
        execSync(`tmux display-message "Error: ${(result.error || 'unknown').replace(/"/g, '')}"`);
      }
    } catch {
      execSync(`tmux display-message "Send failed"`);
    }
  });
});

req.on('error', () => {
  try { execSync(`tmux display-message "Dashboard API unreachable"`); } catch { }
});

req.write(body);
req.end();
