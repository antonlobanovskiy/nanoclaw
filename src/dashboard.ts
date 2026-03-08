import { createServer, IncomingMessage, ServerResponse } from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { WebSocketServer, WebSocket } from 'ws';

import {
  ASSISTANT_NAME,
  DASHBOARD_PORT,
  MAX_CONCURRENT_CONTAINERS,
  STORE_DIR,
} from './config.js';
import {
  getAllTasks,
  getGroupsWithActivity,
  getMessageStats,
  getRecentTaskRunLogs,
  storeMessage,
  storeChatMetadata,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { Channel, RegisteredGroup } from './types.js';

export interface DashboardOptions {
  channels: Channel[];
  queue: GroupQueue;
  registeredGroups: () => Record<string, RegisteredGroup>;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

const startTime = Date.now();
let cpuPrev: { total: number; idle: number } | null = null;
let cachedCpu = 0;

function readCpu(): number {
  const cpus = os.cpus();
  const curr = cpus.reduce(
    (a, c) => {
      const t = Object.values(c.times).reduce((s, v) => s + v, 0);
      return { total: a.total + t, idle: a.idle + c.times.idle };
    },
    { total: 0, idle: 0 },
  );
  if (cpuPrev) {
    const dt = curr.total - cpuPrev.total;
    const di = curr.idle - cpuPrev.idle;
    cachedCpu = dt > 0 ? Math.round((1 - di / dt) * 100) : 0;
  }
  cpuPrev = curr;
  return cachedCpu;
}

function getSystemStatus(opts: DashboardOptions) {
  const cpu = readCpu();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const mem = Math.round((1 - freeMem / totalMem) * 100);

  const channels = opts.channels.map((ch) => ({
    name: ch.name,
    connected: ch.isConnected(),
  }));

  const queueStatus = opts.queue.getStatus();

  return {
    uptime: Date.now() - startTime,
    cpu,
    mem,
    totalMem,
    freeMem,
    channels,
    containers: {
      active: queueStatus.activeCount,
      waiting: queueStatus.waitingCount,
      max: MAX_CONCURRENT_CONTAINERS,
    },
    timestamp: new Date().toISOString(),
  };
}

function getDiskUsage(): Promise<{
  used: number;
  total: number;
  percent: number;
}> {
  return new Promise((resolve) => {
    fs.statfs(STORE_DIR, (err, stats) => {
      if (err) {
        resolve({ used: 0, total: 0, percent: 0 });
        return;
      }
      const total = stats.blocks * stats.bsize;
      const free = stats.bfree * stats.bsize;
      const used = total - free;
      resolve({
        used,
        total,
        percent: Math.round((used / total) * 100),
      });
    });
  });
}

function getContainers(): Promise<
  Array<{ name: string; status: string; created: string }>
> {
  return new Promise((resolve) => {
    exec(
      'docker ps --filter name=nanoclaw- --format "{{json .}}"',
      { timeout: 5000 },
      (err, stdout) => {
        if (err) {
          resolve([]);
          return;
        }
        const containers = stdout
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            try {
              const c = JSON.parse(line);
              return {
                name: c.Names,
                status: c.Status,
                created: c.CreatedAt,
              };
            } catch {
              return null;
            }
          })
          .filter(Boolean) as Array<{
          name: string;
          status: string;
          created: string;
        }>;
        resolve(containers);
      },
    );
  });
}

function findLatestJsonl(
  projectRoot: string,
  groupName: string,
): { path: string; mtime: number } | null {
  const sessionBase = path.join(
    projectRoot,
    'data',
    'sessions',
    groupName,
    '.claude',
    'projects',
  );
  try {
    const projectDirs = fs.readdirSync(sessionBase);
    let latest: { path: string; mtime: number } | null = null;
    for (const dir of projectDirs) {
      const dirPath = path.join(sessionBase, dir);
      let entries;
      try {
        entries = fs.readdirSync(dirPath);
      } catch {
        continue;
      }
      for (const f of entries.filter((e: string) => e.endsWith('.jsonl'))) {
        const fp = path.join(dirPath, f);
        try {
          const st = fs.statSync(fp);
          if (!latest || st.mtimeMs > latest.mtime) {
            latest = { path: fp, mtime: st.mtimeMs };
          }
        } catch {
          /* skip */
        }
      }
    }
    return latest;
  } catch {
    return null;
  }
}

/**
 * Count active subagents for a group by scanning its latest JSONL transcript.
 * A subagent is "active" if we see a Task tool_use without a matching completed result.
 */
function countActiveSubagents(
  projectRoot: string,
  groupName: string,
): { active: number; total: number } {
  const latest = findLatestJsonl(projectRoot, groupName);
  if (!latest) return { active: 0, total: 0 };

  try {
    const content = fs.readFileSync(latest.path, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    // Track spawned task tool_use IDs and completed ones.
    // Reset on each new top-level user prompt so stale subagents
    // from previous conversation turns don't leak through.
    let spawned = new Set<string>();
    let finished = new Set<string>();

    for (const line of lines) {
      try {
        const ev = JSON.parse(line);

        // New user prompt (not a tool result) = new conversation turn
        if (ev.type === 'user' && !ev.toolUseResult) {
          const msgContent = ev.message?.content;
          // Check it's a real user message, not a tool_result
          const isToolResult =
            Array.isArray(msgContent) &&
            msgContent.length > 0 &&
            msgContent[0]?.type === 'tool_result';
          if (!isToolResult) {
            spawned = new Set();
            finished = new Set();
          }
        }

        // Task spawn: assistant message with tool_use name=Task
        if (ev.type === 'assistant') {
          const blocks = ev.message?.content || [];
          if (Array.isArray(blocks)) {
            for (const b of blocks) {
              if (b.type === 'tool_use' && b.name === 'Task' && b.id) {
                spawned.add(b.id);
              }
            }
          }
        }
        // Task completion: user message with toolUseResult referencing a task
        if (ev.type === 'user' && ev.toolUseResult) {
          const msgContent = ev.message?.content;
          if (Array.isArray(msgContent)) {
            for (const c of msgContent) {
              if (c.tool_use_id && spawned.has(c.tool_use_id)) {
                const status =
                  ev.toolUseResult.task?.status || ev.toolUseResult.status;
                if (status === 'completed' || status === 'error') {
                  finished.add(c.tool_use_id);
                }
              }
            }
          }
        }
      } catch {
        /* skip malformed lines */
      }
    }

    return {
      active: spawned.size - finished.size,
      total: spawned.size,
    };
  } catch {
    return { active: 0, total: 0 };
  }
}

function sendJson(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

export function startDashboard(opts: DashboardOptions): void {
  const projectRoot = process.cwd();
  const htmlPath = path.join(projectRoot, 'dashboard', 'web', 'index.html');

  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);

      // Serve frontend
      if (url.pathname === '/' || url.pathname === '/index.html') {
        try {
          const html = fs.readFileSync(htmlPath, 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(html);
        } catch {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Dashboard HTML not found');
        }
        return;
      }

      // API routes
      if (url.pathname === '/api/status') {
        const status = getSystemStatus(opts);
        const disk = await getDiskUsage();
        sendJson(res, { ...status, disk });
        return;
      }

      if (url.pathname === '/api/groups') {
        const groups = getGroupsWithActivity().map((g) => ({
          ...g,
          subagents: countActiveSubagents(projectRoot, g.folder),
        }));
        sendJson(res, groups);
        return;
      }

      if (url.pathname === '/api/tasks') {
        sendJson(res, getAllTasks());
        return;
      }

      if (url.pathname === '/api/tasks/history') {
        const limit = parseInt(url.searchParams.get('limit') || '50', 10);
        sendJson(res, getRecentTaskRunLogs(Math.min(limit, 200)));
        return;
      }

      if (url.pathname === '/api/messages/stats') {
        sendJson(res, getMessageStats());
        return;
      }

      if (url.pathname === '/api/containers') {
        const containers = await getContainers();
        sendJson(res, containers);
        return;
      }

      // Transcript API
      if (url.pathname.startsWith('/api/transcript/')) {
        const group = decodeURIComponent(
          url.pathname.slice('/api/transcript/'.length),
        );
        const latest = findLatestJsonl(projectRoot, group);

        if (!latest) {
          sendJson(res, []);
          return;
        }

        try {
          const content = fs.readFileSync(latest.path, 'utf8');
          const events: unknown[] = [];
          for (const line of content.split('\n').filter(Boolean).slice(-200)) {
            try {
              events.push(JSON.parse(line));
            } catch {
              /* skip */
            }
          }
          sendJson(res, events);
        } catch {
          sendJson(res, []);
        }
        return;
      }

      // Send message to a group from the dashboard
      const sendMatch = url.pathname.match(/^\/api\/groups\/([^/]+)\/send$/);
      if (sendMatch && req.method === 'POST') {
        const folder = decodeURIComponent(sendMatch[1]);
        const groups = opts.registeredGroups();
        const entry = Object.entries(groups).find(([, g]) => g.folder === folder);

        if (!entry) {
          sendJson(res, { error: 'Group not found' }, 404);
          return;
        }

        const [chatJid] = entry;

        // Read POST body
        let body = '';
        for await (const chunk of req) body += chunk;

        let text: string;
        try {
          const parsed = JSON.parse(body);
          text = parsed.text;
        } catch {
          sendJson(res, { error: 'Invalid JSON body' }, 400);
          return;
        }

        if (!text || typeof text !== 'string') {
          sendJson(res, { error: 'Missing text field' }, 400);
          return;
        }

        // Prepend trigger so the agent processes it
        const content = `@${ASSISTANT_NAME} ${text}`;
        const now = new Date();
        const msgId = `dash-${now.getTime()}`;

        // Store as a real message
        storeMessage({
          id: msgId,
          chat_jid: chatJid,
          sender: 'dashboard',
          sender_name: 'Dashboard',
          content,
          timestamp: now.toISOString(),
          is_from_me: false,
        });
        storeChatMetadata(chatJid, now.toISOString());

        // Echo to the channel so the conversation is visible there too
        opts
          .sendMessage(chatJid, `[Dashboard] ${text}`)
          .catch((err) =>
            logger.warn({ chatJid, err }, 'Failed to echo dashboard message to channel'),
          );

        // Enqueue for processing
        opts.queue.enqueueMessageCheck(chatJid);

        logger.info({ folder, chatJid }, 'Dashboard message injected');
        sendJson(res, { ok: true, messageId: msgId });
        return;
      }

      // 404
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    },
  );

  // WebSocket server
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket) => {
    logger.debug('Dashboard WebSocket client connected');
    let watchedFile: string | null = null;
    let watchedOffset = 0;

    const unwatch = () => {
      if (watchedFile) {
        fs.unwatchFile(watchedFile);
        watchedFile = null;
        watchedOffset = 0;
      }
    };

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'subscribe' && msg.group) {
          unwatch();
          const latest = findLatestJsonl(projectRoot, msg.group);
          if (!latest) return;

          watchedFile = latest.path;
          watchedOffset = fs.statSync(watchedFile).size;

          fs.watchFile(watchedFile, { interval: 500 }, () => {
            if (!watchedFile) return;
            try {
              const stat = fs.statSync(watchedFile);
              const toRead = stat.size - watchedOffset;
              if (toRead <= 0) return;

              const buf = Buffer.alloc(toRead);
              const fd = fs.openSync(watchedFile, 'r');
              fs.readSync(fd, buf, 0, toRead, watchedOffset);
              fs.closeSync(fd);
              watchedOffset += toRead;

              const events: unknown[] = [];
              for (const line of buf
                .toString('utf8')
                .split('\n')
                .filter(Boolean)) {
                try {
                  events.push(JSON.parse(line));
                } catch {
                  /* skip */
                }
              }

              if (events.length > 0 && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'transcript', data: events }));
              }
            } catch {
              /* skip */
            }
          });
        }
      } catch {
        /* skip invalid messages */
      }
    });

    ws.on('close', () => {
      unwatch();
      logger.debug('Dashboard WebSocket client disconnected');
    });
  });

  // Broadcast status to all WebSocket clients every 2s
  const statusInterval = setInterval(async () => {
    if (wss.clients.size === 0) return;

    const status = getSystemStatus(opts);
    const disk = await getDiskUsage();
    const payload = JSON.stringify({
      type: 'status',
      data: { ...status, disk },
    });

    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }, 2000);

  // Broadcast groups with subagent counts every 5s
  const groupsInterval = setInterval(() => {
    if (wss.clients.size === 0) return;

    const groups = getGroupsWithActivity().map((g) => ({
      ...g,
      subagents: countActiveSubagents(projectRoot, g.folder),
    }));
    const payload = JSON.stringify({ type: 'groups', data: groups });

    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }, 5000);

  // Broadcast message stats every 30s
  const messageStatsInterval = setInterval(() => {
    if (wss.clients.size === 0) return;

    const stats = getMessageStats();
    const payload = JSON.stringify({ type: 'messages', data: stats });

    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }, 30_000);

  // Broadcast task info every 10s
  const taskInterval = setInterval(() => {
    if (wss.clients.size === 0) return;

    const tasks = getAllTasks();
    const history = getRecentTaskRunLogs(20);
    const payload = JSON.stringify({
      type: 'tasks',
      data: { tasks, history },
    });

    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }, 10_000);

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.warn(
        { port: DASHBOARD_PORT },
        'Dashboard port in use, dashboard disabled',
      );
    } else {
      logger.error({ err }, 'Dashboard server error');
    }
  });

  server.listen(DASHBOARD_PORT, '0.0.0.0', () => {
    logger.info({ port: DASHBOARD_PORT }, 'Dashboard server started');
  });

  process.on('beforeExit', () => {
    clearInterval(statusInterval);
    clearInterval(groupsInterval);
    clearInterval(messageStatsInterval);
    clearInterval(taskInterval);
    wss.close();
    server.close();
  });
}
