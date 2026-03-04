# Web Dashboard Design

**Date:** 2026-03-03
**Status:** Approved

## Goal

Add a real-time web dashboard to NanoClaw, accessible locally and remotely via Tailscale. Provides comprehensive monitoring: agent activity, scheduled tasks, channel health, container state, message analytics, and system resources. Complements the existing terminal dashboard.

---

## Architecture

Embedded HTTP + WebSocket server running inside the NanoClaw process. Direct access to in-memory state (channels, container queue, groups) and SQLite for persistent data.

| Component | Implementation |
|-----------|---------------|
| HTTP server | Node.js built-in `node:http` |
| WebSocket | `ws` package (handles ping/pong, fragmentation) |
| Frontend | Single `dashboard/web/index.html` (vanilla HTML + CSS + JS, no build step) |
| Port | `DASHBOARD_PORT` env var, default `3000` |
| Auth | None — Tailscale provides network-level security |

---

## API Endpoints

All return JSON.

| Endpoint | Data | Source |
|----------|------|--------|
| `GET /api/status` | Uptime, CPU%, mem%, disk, channel status, container queue | `os` module, `channels[].isConnected()`, `queue`, `fs.statfs` |
| `GET /api/groups` | Registered groups with last activity | SQLite `registered_groups` + `chats` |
| `GET /api/tasks` | Scheduled tasks (next_run, last_run, last_result, status) | SQLite `scheduled_tasks` |
| `GET /api/tasks/history?limit=50` | Recent task run logs | SQLite `task_run_logs` |
| `GET /api/messages/stats` | Messages per hour (24h), per day (7d), per channel | SQLite `messages` aggregates |
| `GET /api/containers` | Running Docker containers | `docker ps --filter name=nanoclaw- --format json` |

---

## WebSocket Events

Connection at `/ws`. Server pushes events as JSON `{ type, data }`.

| Event | Payload | Trigger | Interval |
|-------|---------|---------|----------|
| `status` | Same as `/api/status` | Timer | 2s |
| `transcript` | `{ group, events[] }` | JSONL file change | 500ms watch |
| `container:start` | `{ group, containerName }` | Container spawned | Event-driven |
| `container:stop` | `{ group, duration, exitCode }` | Container exited | Event-driven |
| `task:run` | `{ taskId, status, duration }` | Task completed | Event-driven |

---

## Frontend Layout

Dark theme, CSS Grid, four quadrants with header bar.

```
┌─────────────────────────────────────────────────────────────────────┐
│  NANOCLAW  ● up 3d 12h   CPU ▓▓▓░░ 23%  MEM ▓▓▓▓░ 61%           │
│  Disk ▓▓░░░ 42%  Channels: Discord ● Telegram ○  Containers 2/5   │
├───────────────────────────────┬─────────────────────────────────────┤
│  AGENTS                       │  SCHEDULED TASKS                    │
│  ● grocery    active 2m       │  ✓ price-scrape    8:00 AM          │
│    opus · Bash: sqlite3...    │    Last: ✓ 4m32s   Next: 8h         │
│  ● main       active 14s     │  ✓ daily-summary   9:00 PM          │
│    opus · Read: /home/...     │    Last: ✓ 1m12s   Next: 3h         │
│  ○ personal   idle 3h        │  ✗ backup          failed            │
│                                │    Last: ✗ timeout  Next: 1d        │
├───────────────────────────────┼─────────────────────────────────────┤
│  TRANSCRIPT [grocery]          │  ANALYTICS                          │
│                                │  Messages today: 47                 │
│  [user]                        │  ┌───────────────────────────┐     │
│    What's on the list?         │  │  ▇ ▇ ▅ ▃ ▁ ▃ ▅ ▇ ▆ ▃    │     │
│  [assistant]                   │  │  8  10  12  2   4  6  8   │     │
│    Here's your shopping list.. │  └───────────────────────────┘     │
│  [tool_use] Bash               │  By channel:                       │
│    sqlite3 grocery.db "SELECT  │    Discord: 42  Telegram: 5        │
│  [tool_result]                 │                                    │
│    eggs, milk, bread...        │  Containers today: 14              │
│                                │  Avg duration: 3m24s               │
└───────────────────────────────┴─────────────────────────────────────┘
```

**Interactions:**
- Click agent to switch transcript view
- Click task to see run history
- Auto-refreshes via WebSocket
- Responsive: stacks to single column on mobile

**Color scheme:**
- Background: `#0d1117` (GitHub dark)
- Cards: `#161b22`
- Borders: `#30363d`
- Text: `#c9d1d9`
- Green (active/success): `#3fb950`
- Red (error/disconnected): `#f85149`
- Yellow (tool calls): `#d29922`
- Cyan (user messages): `#58a6ff`
- Dim: `#8b949e`

---

## Server Integration

### New module: `src/dashboard.ts`

```typescript
export interface DashboardOptions {
  channels: Channel[];
  queue: GroupQueue;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export function startDashboard(opts: DashboardOptions): void;
```

### Changes to `src/index.ts`

```typescript
import { startDashboard } from './dashboard.js';

// In main(), after startMessageLoop:
startDashboard({ channels, queue, registeredGroups: () => registeredGroups });
```

### Changes to `src/group-queue.ts`

Add public method:
```typescript
getStatus(): { activeCount: number; waitingCount: number; groups: Map<string, GroupState> }
```

### Changes to `src/config.ts`

```typescript
export const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || '3000', 10);
```

---

## Files

| Action | File |
|--------|------|
| Create | `src/dashboard.ts` |
| Create | `dashboard/web/index.html` |
| Modify | `src/index.ts` (import + call startDashboard) |
| Modify | `src/group-queue.ts` (add getStatus method) |
| Modify | `src/config.ts` (add DASHBOARD_PORT) |
| Modify | `package.json` (add ws, @types/ws) |

---

## Data Flow

```
Browser ──GET /──> HTTP server ──> serves index.html
Browser ──WS /ws──> WebSocket server
                      │
                      ├── 2s timer: reads os.cpus(), os.freemem(),
                      │   channels[].isConnected(), queue.getStatus(),
                      │   docker ps → pushes "status" event
                      │
                      ├── 500ms fs.watchFile on JSONL:
                      │   reads new bytes → parses events → pushes "transcript"
                      │
                      └── Event hooks (future): container spawn/exit, task completion
                          → pushes container:start/stop, task:run events

Browser ──GET /api/*──> HTTP server ──> SQLite queries ──> JSON response
```

---

## What's NOT included (YAGNI)

- No authentication (Tailscale handles it)
- No container management (kill/restart from UI)
- No log viewer (terminal dashboard + service log already covers this)
- No chat/message content viewer (privacy — only aggregate stats)
- No persistent metrics storage (all computed on-the-fly from SQLite)
- No configuration editing from the UI
