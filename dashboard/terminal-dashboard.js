#!/usr/bin/env node
/**
 * NanoClaw Terminal Monitor
 * Reads data directly from filesystem — no API server dependency.
 *
 * Controls: Tab=cycle agents  ↑↓=scroll  g=follow  r=restart  q=quit
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { exec } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// ── Paths ────────────────────────────────────────────────────────────────────
const HOME = os.homedir();
const BASE = path.join(HOME, 'dev/NanoClaw');
const DB_PATH = path.join(BASE, 'store/messages.db');
const LOG_PATH = path.join(BASE, 'logs/nanoclaw.log');
const SESSIONS_DIR = path.join(BASE, 'data/sessions');
const IPC_DIR = path.join(BASE, 'data/ipc');

// ── ANSI ─────────────────────────────────────────────────────────────────────
const ESC = '\x1b[';
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const CLEAR = `${ESC}2J${ESC}H`;
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const RED = `${ESC}31m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const CYAN = `${ESC}36m`;
const WHITE = `${ESC}37m`;
const GRAY = `${ESC}90m`;
const ORANGE = `${ESC}33m`;
const B_GREEN = `${ESC}92m`;

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
  selectedAgent: null,
  transcript: [],
  transcriptScroll: 0,
  serviceLog: [],
  serviceStatus: 'unknown',
  cpu: 0,
  mem: 0,
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function clamp(str, width) {
  if (str.length > width) return str.slice(0, width - 1) + '…';
  return str.padEnd(width);
}

function now() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

// ── Entry point ───────────────────────────────────────────────────────────────
process.stdout.write(HIDE_CURSOR + CLEAR);

function cleanup() {
  process.stdout.write(SHOW_CURSOR + `${ESC}?1049l`);
  process.exit(0);
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

console.log('NanoClaw Terminal Monitor - scaffold OK');
setTimeout(cleanup, 2000);
