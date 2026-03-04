# Web Dashboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a real-time web dashboard to NanoClaw with monitoring for agents, tasks, channels, containers, and message analytics.

**Architecture:** Embedded HTTP + WebSocket server inside the NanoClaw process (`src/dashboard.ts`). Uses `ws` package for WebSocket, Node built-in `http` for HTTP. Single-file vanilla frontend at `dashboard/web/index.html`. Dark theme, CSS Grid, four-quadrant layout.

**Tech Stack:** Node.js `http`, `ws` package, `better-sqlite3` (existing), vanilla HTML/CSS/JS

**Design doc:** `docs/plans/2026-03-03-web-dashboard-design.md`

---

### Task 1: Install dependencies and add config

**Files:**
- Modify: `package.json` (add `ws`, `@types/ws`)
- Modify: `src/config.ts:16` (add `DASHBOARD_PORT`)

**Step 1: Install ws package**

Run: `npm install ws && npm install -D @types/ws`

**Step 2: Add DASHBOARD_PORT to config**

In `src/config.ts`, add after line 16 (`export const SCHEDULER_POLL_INTERVAL = 60000;`):

```typescript
export const DASHBOARD_PORT = parseInt(
  process.env.DASHBOARD_PORT || '3000',
  10,
);
```

**Step 3: Verify build**

Run: `npm run build`
Expected: Compiles successfully (same pre-existing errors in whatsapp files, no new errors).

**Step 4: Commit**

```bash
git add package.json package-lock.json src/config.ts
git commit -m "feat(dashboard): add ws dependency and DASHBOARD_PORT config"
```

---

### Task 2: Add getStatus() to GroupQueue

**Files:**
- Modify: `src/group-queue.ts:29` (export GroupState interface, add getStatus method)
- Modify: `src/group-queue.test.ts` (add test)

**Step 1: Write the failing test**

Add to `src/group-queue.test.ts` at the end of the `describe('GroupQueue', ...)` block:

```typescript
  describe('getStatus', () => {
    it('returns active and waiting counts', () => {
      const status = queue.getStatus();
      expect(status.activeCount).toBe(0);
      expect(status.waitingCount).toBe(0);
      expect(status.groups).toBeInstanceOf(Map);
    });

    it('reflects active containers after enqueue', async () => {
      const processMessages = vi.fn(async () => {
        // Check status while container is active
        const status = queue.getStatus();
        expect(status.activeCount).toBe(1);
        return true;
      });
      queue.setProcessMessagesFn(processMessages);
      queue.enqueueMessageCheck('group-a');
      await vi.advanceTimersByTimeAsync(200);
    });
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/group-queue.test.ts`
Expected: FAIL — `queue.getStatus is not a function`

**Step 3: Implement getStatus**

In `src/group-queue.ts`:

1. Export the `GroupState` interface (move from inside the file to exported, at line 17):

Change `interface GroupState {` to `export interface GroupState {`

2. Add the `getStatus` method to the `GroupQueue` class (after the `setProcessMessagesFn` method, around line 58):

```typescript
  getStatus(): { activeCount: number; waitingCount: number; groups: Map<string, GroupState> } {
    return {
      activeCount: this.activeCount,
      waitingCount: this.waitingGroups.length,
      groups: new Map(this.groups),
    };
  }
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/group-queue.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/group-queue.ts src/group-queue.test.ts
git commit -m "feat(dashboard): add getStatus() to GroupQueue"
```

---

### Task 3: Add dashboard DB query functions

**Files:**
- Modify: `src/db.ts` (add `getMessageStats`, `getTaskRunLogs`, `getGroupsWithActivity`)
- Modify: `src/db.test.ts` (add tests)

**Step 1: Write failing tests**

Add to `src/db.test.ts`:

```typescript
describe('getMessageStats', () => {
  it('returns hourly counts for last 24h', () => {
    storeChatMetadata('dc:123', '2024-01-01T12:00:00.000Z', 'test', 'discord', true);
    const now = new Date();
    // Store messages at various hours
    for (let i = 0; i < 5; i++) {
      const ts = new Date(now.getTime() - i * 3600_000);
      store({
        id: `msg-${i}`,
        chat_jid: 'dc:123',
        sender: 'user1',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: ts.toISOString(),
      });
    }
    const stats = getMessageStats();
    expect(stats.today).toBeGreaterThanOrEqual(5);
    expect(stats.hourly).toBeInstanceOf(Array);
    expect(stats.hourly.length).toBeLessThanOrEqual(24);
    expect(stats.byChannel).toBeInstanceOf(Array);
  });
});

describe('getTaskRunLogs', () => {
  it('returns recent task run logs', () => {
    // We need the imports: logTaskRun, getRecentTaskRunLogs
    createTask({
      id: 'task-1',
      group_folder: 'test',
      chat_jid: 'dc:123',
      prompt: 'test task',
      schedule_type: 'cron',
      schedule_value: '0 8 * * *',
      context_mode: 'isolated',
      next_run: new Date().toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
    });
    logTaskRun({
      task_id: 'task-1',
      run_at: new Date().toISOString(),
      duration_ms: 5000,
      status: 'success',
      result: 'done',
      error: null,
    });
    const logs = getRecentTaskRunLogs(10);
    expect(logs.length).toBe(1);
    expect(logs[0].task_id).toBe('task-1');
    expect(logs[0].duration_ms).toBe(5000);
  });
});

describe('getGroupsWithActivity', () => {
  it('joins registered_groups with chats for last activity', () => {
    storeChatMetadata('dc:123', '2024-01-01T12:00:00.000Z', 'Test Group', 'discord', true);
    setRegisteredGroup('dc:123', {
      name: 'Test Group',
      folder: 'test',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });
    const groups = getGroupsWithActivity();
    expect(groups.length).toBe(1);
    expect(groups[0].name).toBe('Test Group');
    expect(groups[0].lastActivity).toBe('2024-01-01T12:00:00.000Z');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/db.test.ts`
Expected: FAIL — functions not exported

**Step 3: Implement the query functions**

Add to `src/db.ts` (before the `// --- Router state accessors ---` section):

```typescript
// --- Dashboard query functions ---

export interface MessageStats {
  today: number;
  hourly: Array<{ hour: string; count: number }>;
  byChannel: Array<{ channel: string; count: number }>;
  daily: Array<{ date: string; count: number }>;
}

export function getMessageStats(): MessageStats {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const yesterday = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600_000).toISOString();

  const today = (db.prepare(
    `SELECT COUNT(*) as count FROM messages WHERE timestamp >= ?`
  ).get(todayStart) as { count: number }).count;

  const hourly = db.prepare(`
    SELECT strftime('%Y-%m-%dT%H:00:00', timestamp) as hour, COUNT(*) as count
    FROM messages WHERE timestamp >= ?
    GROUP BY hour ORDER BY hour
  `).all(yesterday) as Array<{ hour: string; count: number }>;

  const byChannel = db.prepare(`
    SELECT c.channel, COUNT(*) as count
    FROM messages m JOIN chats c ON m.chat_jid = c.jid
    WHERE m.timestamp >= ?
    GROUP BY c.channel
  `).all(todayStart) as Array<{ channel: string; count: number }>;

  const daily = db.prepare(`
    SELECT date(timestamp) as date, COUNT(*) as count
    FROM messages WHERE timestamp >= ?
    GROUP BY date ORDER BY date
  `).all(weekAgo) as Array<{ date: string; count: number }>;

  return { today, hourly, byChannel, daily };
}

export function getRecentTaskRunLogs(limit: number): TaskRunLog[] {
  return db.prepare(
    `SELECT task_id, run_at, duration_ms, status, result, error
     FROM task_run_logs ORDER BY run_at DESC LIMIT ?`
  ).all(limit) as TaskRunLog[];
}

export interface GroupWithActivity {
  jid: string;
  name: string;
  folder: string;
  channel: string | null;
  lastActivity: string | null;
  isMain: boolean;
}

export function getGroupsWithActivity(): GroupWithActivity[] {
  return db.prepare(`
    SELECT rg.jid, rg.name, rg.folder, c.channel, c.last_message_time as lastActivity, rg.is_main as isMain
    FROM registered_groups rg
    LEFT JOIN chats c ON rg.jid = c.jid
    ORDER BY c.last_message_time DESC
  `).all() as GroupWithActivity[];
}
```

Update the import in `src/db.test.ts` to include the new functions:
```typescript
import {
  _initTestDatabase,
  createTask,
  deleteTask,
  getAllChats,
  getAllRegisteredGroups,
  getGroupsWithActivity,
  getMessageStats,
  getMessagesSince,
  getNewMessages,
  getRecentTaskRunLogs,
  getTaskById,
  logTaskRun,
  setRegisteredGroup,
  storeChatMetadata,
  storeMessage,
  updateTask,
} from './db.js';
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/db.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat(dashboard): add message stats, task logs, and group activity DB queries"
```

---

### Task 4: Create dashboard server module

**Files:**
- Create: `src/dashboard.ts`

This is the core server module. It creates the HTTP server, serves the frontend, handles API routes, and manages WebSocket connections.

**Step 1: Create `src/dashboard.ts`**

```typescript
import { createServer, IncomingMessage, ServerResponse } from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { WebSocketServer, WebSocket } from 'ws';

import { DASHBOARD_PORT, STORE_DIR } from './config.js';
import {
  getAllTasks,
  getGroupsWithActivity,
  getMessageStats,
  getRecentTaskRunLogs,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { Channel, RegisteredGroup } from './types.js';

export interface DashboardOptions {
  channels: Channel[];
  queue: GroupQueue;
  registeredGroups: () => Record<string, RegisteredGroup>;
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
      max: 5, // MAX_CONCURRENT_CONTAINERS from config
    },
    timestamp: new Date().toISOString(),
  };
}

function getDiskUsage(): Promise<{ used: number; total: number; percent: number }> {
  return new Promise((resolve) => {
    const storePath = STORE_DIR;
    fs.statfs(storePath, (err, stats) => {
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

function getContainers(): Promise<Array<{ name: string; status: string; created: string }>> {
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
          .filter(Boolean) as Array<{ name: string; status: string; created: string }>;
        resolve(containers);
      },
    );
  });
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

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
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
      sendJson(res, getGroupsWithActivity());
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

    // 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  // WebSocket server
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket) => {
    logger.debug('Dashboard WebSocket client connected');

    ws.on('close', () => {
      logger.debug('Dashboard WebSocket client disconnected');
    });
  });

  // Broadcast status to all WebSocket clients every 2s
  const statusInterval = setInterval(async () => {
    if (wss.clients.size === 0) return;

    const status = getSystemStatus(opts);
    const disk = await getDiskUsage();
    const payload = JSON.stringify({ type: 'status', data: { ...status, disk } });

    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }, 2000);

  // Broadcast message stats every 30s (less frequent — aggregate data)
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
    const payload = JSON.stringify({ type: 'tasks', data: { tasks, history } });

    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }, 10_000);

  server.listen(DASHBOARD_PORT, '0.0.0.0', () => {
    logger.info({ port: DASHBOARD_PORT }, 'Dashboard server started');
  });

  // Cleanup on process exit
  process.on('beforeExit', () => {
    clearInterval(statusInterval);
    clearInterval(messageStatsInterval);
    clearInterval(taskInterval);
    wss.close();
    server.close();
  });
}
```

**Step 2: Verify build compiles**

Run: `npm run build`
Expected: Compiles without new errors.

**Step 3: Commit**

```bash
git add src/dashboard.ts
git commit -m "feat(dashboard): create HTTP + WebSocket dashboard server"
```

---

### Task 5: Integrate dashboard into main process

**Files:**
- Modify: `src/index.ts:2` (add import)
- Modify: `src/index.ts:579` (call startDashboard before message loop)

**Step 1: Add import**

In `src/index.ts`, add after the existing imports (after line 46):

```typescript
import { startDashboard } from './dashboard.js';
```

**Step 2: Start dashboard in main()**

In `src/index.ts`, in the `main()` function, add after `queue.setProcessMessagesFn(processGroupMessages);` (after line 577) and before `recoverPendingMessages();`:

```typescript
  // Start web dashboard
  startDashboard({ channels, queue, registeredGroups: () => registeredGroups });
```

**Step 3: Verify build**

Run: `npm run build`
Expected: Compiles without new errors.

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(dashboard): integrate dashboard server into main process"
```

---

### Task 6: Create the frontend HTML

**Files:**
- Create: `dashboard/web/index.html`

This is the single-file frontend. It contains all HTML, CSS, and JavaScript inline. Uses WebSocket for real-time updates and fetch for initial data load.

**Step 1: Create `dashboard/web/` directory**

Run: `mkdir -p dashboard/web`

**Step 2: Create `dashboard/web/index.html`**

Create the file with the full frontend implementation. The file is structured as:

1. **HTML structure:** Header bar, four-quadrant CSS Grid layout (Agents, Tasks, Transcript, Analytics)
2. **CSS:** Dark theme matching the design doc colors, responsive grid, component styles
3. **JavaScript:**
   - WebSocket connection with auto-reconnect
   - `fetch()` calls for initial data load (`/api/groups`, `/api/tasks`, `/api/tasks/history`, `/api/messages/stats`, `/api/containers`)
   - DOM update functions for each section
   - Progress bars for CPU/MEM/Disk
   - Agent click handler to switch transcript view
   - Message volume bar chart (CSS-only, no chart library)
   - Relative time formatting ("2m ago", "3h ago")
   - Mobile responsive (single column under 768px)

Key frontend behaviors:
- On connect: fetches all API endpoints once to populate UI
- WebSocket `status` events (2s): update header bar (CPU, MEM, disk, channels, containers)
- WebSocket `messages` events (30s): update analytics panel
- WebSocket `tasks` events (10s): update tasks panel
- Agent click: fetches transcript JSONL for selected agent (reuses `findLatestJsonl` pattern from terminal dashboard's `lib.js`)
- Transcript: initially empty, populated when an agent is selected. The transcript viewer parses JSONL events from the `data/sessions/{group}/` directory via a new `/api/transcript/:group` endpoint.

**Note:** We need to add one more API endpoint for transcript data. Add to `src/dashboard.ts`:

```typescript
    if (url.pathname.startsWith('/api/transcript/')) {
      const group = decodeURIComponent(url.pathname.slice('/api/transcript/'.length));
      const sessionsDir = path.join(projectRoot, 'data', 'sessions');
      const sessionBase = path.join(sessionsDir, group, '.claude', 'projects');

      try {
        const projectDirs = fs.readdirSync(sessionBase);
        let latest: { path: string; mtime: number } | null = null;
        for (const dir of projectDirs) {
          const dirPath = path.join(sessionBase, dir);
          let entries;
          try { entries = fs.readdirSync(dirPath); } catch { continue; }
          for (const f of entries.filter((f: string) => f.endsWith('.jsonl'))) {
            const fp = path.join(dirPath, f);
            try {
              const st = fs.statSync(fp);
              if (!latest || st.mtimeMs > latest.mtime) {
                latest = { path: fp, mtime: st.mtimeMs };
              }
            } catch { /* skip */ }
          }
        }

        if (!latest) {
          sendJson(res, []);
          return;
        }

        const content = fs.readFileSync(latest.path, 'utf8');
        const events: unknown[] = [];
        for (const line of content.split('\n').filter(Boolean).slice(-200)) {
          try {
            const obj = JSON.parse(line);
            events.push(obj);
          } catch { /* skip */ }
        }
        sendJson(res, events);
      } catch {
        sendJson(res, []);
      }
      return;
    }
```

The full `index.html` content is large (~600 lines). Key sections:

**HTML:**
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NanoClaw Dashboard</title>
  <!-- All CSS inline -->
</head>
<body>
  <header id="header"><!-- Status bar --></header>
  <main id="grid">
    <section id="agents"><!-- Agent list --></section>
    <section id="tasks"><!-- Scheduled tasks --></section>
    <section id="transcript"><!-- Live transcript --></section>
    <section id="analytics"><!-- Message analytics --></section>
  </main>
  <!-- All JS inline -->
</body>
</html>
```

**CSS Grid:**
```css
#grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: minmax(200px, 1fr) minmax(300px, 2fr);
  gap: 1px;
  height: calc(100vh - 60px);
  background: #30363d;
}
@media (max-width: 768px) {
  #grid { grid-template-columns: 1fr; }
}
```

**JS WebSocket:**
```javascript
let ws;
function connectWs() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'status') updateStatus(msg.data);
    if (msg.type === 'messages') updateAnalytics(msg.data);
    if (msg.type === 'tasks') updateTasks(msg.data);
  };
  ws.onclose = () => setTimeout(connectWs, 2000);
}
connectWs();
```

**Step 3: Verify the dashboard loads**

Run: `npm run dev` (in one terminal), then open `http://localhost:3000` in a browser.
Expected: Dashboard renders with dark theme, shows real-time data.

**Step 4: Commit**

```bash
git add dashboard/web/index.html src/dashboard.ts
git commit -m "feat(dashboard): add web frontend with real-time monitoring"
```

---

### Task 7: Add JSONL transcript WebSocket streaming

**Files:**
- Modify: `src/dashboard.ts` (add JSONL file watcher for transcript streaming)

**Step 1: Add transcript watcher to WebSocket connection handler**

When a WebSocket client connects and sends a `{ type: 'subscribe', group: 'groupname' }` message, the server starts watching that group's JSONL file and streams new events.

Add to the `wss.on('connection', ...)` handler in `src/dashboard.ts`:

```typescript
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
          const sessionsDir = path.join(projectRoot, 'data', 'sessions');
          const sessionBase = path.join(sessionsDir, msg.group, '.claude', 'projects');

          // Find latest JSONL
          let latest: { path: string; mtime: number } | null = null;
          try {
            const projectDirs = fs.readdirSync(sessionBase);
            for (const dir of projectDirs) {
              const dirPath = path.join(sessionBase, dir);
              let entries;
              try { entries = fs.readdirSync(dirPath); } catch { continue; }
              for (const f of entries.filter((e: string) => e.endsWith('.jsonl'))) {
                const fp = path.join(dirPath, f);
                try {
                  const st = fs.statSync(fp);
                  if (!latest || st.mtimeMs > latest.mtime) {
                    latest = { path: fp, mtime: st.mtimeMs };
                  }
                } catch { /* skip */ }
              }
            }
          } catch { /* skip */ }

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
              for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
                try { events.push(JSON.parse(line)); } catch { /* skip */ }
              }

              if (events.length > 0 && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'transcript', data: events }));
              }
            } catch { /* skip */ }
          });
        }
      } catch { /* skip invalid messages */ }
    });

    ws.on('close', () => {
      unwatch();
      logger.debug('Dashboard WebSocket client disconnected');
    });
  });
```

**Step 2: Update frontend to use transcript streaming**

In `dashboard/web/index.html`, when user clicks an agent, send subscribe message:

```javascript
function selectAgent(groupFolder) {
  selectedAgent = groupFolder;
  // Fetch initial transcript
  fetch(`/api/transcript/${encodeURIComponent(groupFolder)}`)
    .then(r => r.json())
    .then(events => renderTranscript(events));
  // Subscribe to live updates
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'subscribe', group: groupFolder }));
  }
}
```

Handle incoming transcript events:
```javascript
if (msg.type === 'transcript') {
  appendTranscript(msg.data);
}
```

**Step 3: Verify live transcript updates**

Run the service with `npm run dev`, open dashboard, click an agent. Send a message to that agent through Discord. Verify the transcript updates in real-time.

**Step 4: Commit**

```bash
git add src/dashboard.ts dashboard/web/index.html
git commit -m "feat(dashboard): add live JSONL transcript streaming via WebSocket"
```

---

### Task 8: Final integration test and polish

**Files:**
- Modify: `dashboard/web/index.html` (polish, error states, loading states)

**Step 1: Test all dashboard features**

Run: `npm run dev`

Verify checklist:
- [ ] Dashboard loads at `http://localhost:3000`
- [ ] Header shows service uptime, CPU, memory, disk usage
- [ ] Channel status shows connected/disconnected
- [ ] Container count shows active/max
- [ ] Agent list shows all registered groups with active/idle status
- [ ] Clicking an agent loads transcript
- [ ] Scheduled tasks show with next run time and last result
- [ ] Task history shows success/failure with duration
- [ ] Message analytics show today count, hourly chart, per-channel breakdown
- [ ] WebSocket reconnects on disconnect
- [ ] Mobile layout stacks to single column

**Step 2: Add loading and empty states**

Add to frontend:
- Loading spinner while initial data loads
- "No agents registered" when agents list is empty
- "No scheduled tasks" when tasks list is empty
- "Select an agent to view transcript" in transcript pane initially
- "No message data" in analytics when no messages exist

**Step 3: Verify build passes**

Run: `npm run build`
Expected: No new errors.

**Step 4: Final commit**

```bash
git add dashboard/web/index.html
git commit -m "feat(dashboard): polish UI with loading states and empty states"
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Install deps + config | `package.json`, `src/config.ts` |
| 2 | GroupQueue.getStatus() | `src/group-queue.ts`, `src/group-queue.test.ts` |
| 3 | Dashboard DB queries | `src/db.ts`, `src/db.test.ts` |
| 4 | Dashboard server module | `src/dashboard.ts` |
| 5 | Main process integration | `src/index.ts` |
| 6 | Frontend HTML | `dashboard/web/index.html`, `src/dashboard.ts` |
| 7 | Live transcript streaming | `src/dashboard.ts`, `dashboard/web/index.html` |
| 8 | Integration test + polish | `dashboard/web/index.html` |
