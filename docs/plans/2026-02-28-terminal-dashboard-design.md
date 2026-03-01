# Terminal Dashboard Redesign

**Date:** 2026-02-28
**Status:** Approved

## Goal

Replace the existing terminal dashboard with a focused TUI that gives real-time visibility into what NanoClaw agents are actively doing — their tool calls, Claude session transcripts, and service logs. Remove cost tracking (Claude Max subscription). Retire the web dashboard (React + Express API server).

---

## Architecture

Standalone Node.js process. Reads all data directly from the filesystem — no dependency on the API server.

| What | Source | Method |
|------|--------|--------|
| Service status | `systemctl --user is-active nanoclaw` | exec, polled 5s |
| CPU / memory | Node.js `os` module | polled 2s |
| Agent list + current tool | IPC `current_tasks.json` + JSONL last entry | polled 2s |
| Claude transcript | Session JSONL for selected agent | `fs.watchFile()` 500ms |
| Service log | `~/dev/NanoClaw/logs/nanoclaw.log` | `fs.watchFile()` 500ms |

File: `terminal-dashboard.js` (rewrite in place, same entry point).

---

## Layout

```
┌─ NANOCLAW ── ● running ── cpu 23% mem 61% ── 2 agents ── 17:42:33 ──────────┐
├──────────────────────────────────────────────────────────────────────────────┤
│ AGENTS                                                                       │
│ ● main      ► tool_use: Bash › git status --short           active   1m32s  │
│ ● personal  ► tool_use: Read › /home/user/notes.md          active   0m14s  │
│ ○ work      idle                                                     3h ago  │
├──────────────────────────────┬───────────────────────────────────────────────┤
│ TRANSCRIPT  [main]           │ SERVICE LOG                                   │
│                              │                                               │
│ [user]                       │ 17:41:02 INFO  Spawned: main                  │
│   Check the latest commit    │ 17:41:05 INFO  Tool: Bash                     │
│                              │ 17:41:20 INFO  Agent done: main (32s)         │
│ [assistant]                  │ 17:42:01 INFO  Spawned: personal              │
│   I'll look at git history.  │ 17:42:03 WARN  Slow tool response 12s        │
│                              │                                               │
│ [tool_use] Bash              │                                               │
│   git log --oneline -10      │                                               │
│                              │                                               │
│ [tool_result]                │                                               │
│   abc123 fix auth bug        │                                               │
│   def456 add profile page    │                                               │
│   ...                        │                                               │
│                              │                                               │
│ [assistant]                  │                                               │
│   The last two commits...    │                                               │
├──────────────────────────────┴───────────────────────────────────────────────┤
│ [Tab] cycle agents  [↑↓] scroll  [g] follow  [r] restart service  [q] quit  │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Proportions:** Header 1 line, agent panel ~4 lines, legend 1 line, remainder split transcript (60%) / service log (40%).

---

## Color Scheme (256-color terminal)

| Element | Color |
|---------|-------|
| `[user]` label | Cyan |
| `[assistant]` label | Green |
| `[tool_use]` label + name | Yellow, name bold |
| `[tool_result]` label | Dim white |
| Active agent dot `●` | Bright green |
| Idle agent dot `○` | Dim grey |
| `WARN` log lines | Orange |
| `ERROR` log lines | Red |
| Header bar | Dim background, accent text |
| Legend bar | Dim background |

---

## Agent Panel

- One line per registered group (from SQLite `registered_groups` table)
- Active status determined by: IPC `current_tasks.json` exists OR JSONL modified in last 60s
- Current tool from: last `tool_use` entry in JSONL
- Uptime from: JSONL first entry timestamp vs now
- Updates every 2s

---

## Claude Transcript Pane

**Session file location:**
```
~/dev/NanoClaw/data/sessions/{group}/
  .claude/projects/-workspace-{group}/{sessionId}.jsonl
```

**Finding active session:** Most recently modified `.jsonl` file under the group's session directory (stat all, pick newest).

**Watching:** `fs.watchFile()` on the active JSONL file, 500ms poll. On change, read new bytes from tracked offset, split on newlines, parse JSON, append to buffer.

**Buffer:** Last 500 events in memory. Rendered from bottom up in follow mode.

**JSONL event rendering:**

| Event | Fields | Display |
|-------|--------|---------|
| `user` | `message.content[].text` | `[user]\n  {text}` |
| `assistant` (text) | `message.content[].text` | `[assistant]\n  {text}` |
| `assistant` (tool_use) | `content[].name`, `content[].input` | `[tool_use] {name}\n  {compact input}` |
| `tool` (result) | `content[].content[].text` | `[tool_result]\n  {first 20 lines, then "… N more"}` |

**Agent switching:** Auto-follows most recently active agent. `Tab` manually cycles. When session file changes (new agent spawn), buffer clears and a `── new session ──` divider appears.

---

## Service Log Pane

- Tails `~/dev/NanoClaw/logs/nanoclaw.log` via `fs.watchFile()` 500ms
- Keeps last 200 lines in memory
- Auto-scrolls to bottom always (no scroll control needed — transcript pane is the one users scroll)
- Colourises WARN/ERROR lines

---

## Keyboard Controls

| Key | Action |
|-----|--------|
| `Tab` | Cycle transcript between active agents |
| `↑` / `↓` | Scroll transcript pane |
| `g` | Jump to bottom, re-enable follow mode |
| `r` | Restart nanoclaw service (`systemctl --user restart nanoclaw`) |
| `q` / `Ctrl+C` | Quit dashboard |

---

## What's Removed

- Cost tracking (token costs, USD estimates)
- Model usage bar chart
- System resources chart (CPU/mem bars kept in header, chart dropped)
- Scheduled tasks panel
- Web dashboard (`dashboard/web/`, `dashboard/api/`) — retired
- Docker container kill buttons (terminal TUI only, no interactive container management)
