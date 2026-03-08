#!/usr/bin/env bash
# NanoClaw tmux dashboard launcher.
# Layout: 1-row status bar, 1-row agents, then transcript | tasks+log (60/40).
# Keys: Tab=cycle agents, i=input message, q=quit
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
SESSION="nanoclaw"
LOG_PATH="$HOME/dev/NanoClaw/logs/nanoclaw.log"

# Kill existing session if any
tmux kill-session -t "$SESSION" 2>/dev/null || true

# Clean up stale agent selection
rm -f /tmp/nc-dash-agent

# ── Create session with status bar (pane 0) ──────────────────────────────────
tmux new-session -d -s "$SESSION" \
  "node '$DIR/status-bar.js'"

# ── Pane 1: agents panel (1 row below status bar) ────────────────────────────
tmux split-window -t "$SESSION:0.0" -v -l 99% \
  "node '$DIR/agents-panel.js'"
tmux resize-pane -t "$SESSION:0.0" -y 1

# ── Pane 2: transcript viewer (below agents, takes remaining height) ─────────
tmux split-window -t "$SESSION:0.1" -v -l 99% \
  "node '$DIR/transcript-viewer.js'"
tmux resize-pane -t "$SESSION:0.1" -y 1

# ── Pane 3: right column (tasks + log stacked) ───────────────────────────────
tmux split-window -t "$SESSION:0.2" -h -l 40% \
  "node '$DIR/tasks-panel.js'"

# ── Pane 4: service log (below tasks, 60% of right column) ───────────────────
tmux split-window -t "$SESSION:0.3" -v -l 60% \
  "tail -f '$LOG_PATH' 2>/dev/null | bash '$DIR/log-colorizer.sh'"

# ── Focus the status-bar pane (pane 0) so keystrokes go nowhere useful ────────
tmux select-pane -t "$SESSION:0.0"

# ── Styling ───────────────────────────────────────────────────────────────────
tmux set-option -t "$SESSION" status off
tmux set-option -t "$SESSION" pane-border-style "fg=colour240"
tmux set-option -t "$SESSION" pane-active-border-style "fg=colour240"
tmux set-option -t "$SESSION" pane-border-lines single

# Disable all prefix keys — session is controlled only by root bindings below
tmux set-option -t "$SESSION" prefix None

# ── Key bindings ──────────────────────────────────────────────────────────────
tmux bind-key -n q kill-session -t "$SESSION"
tmux bind-key -n Tab send-keys -t "$SESSION:0.1" Tab

# 'i' key: open input prompt to send a message to the selected agent
tmux bind-key -n i run-shell "node '$DIR/input-prompt.js'"

# ── Attach ────────────────────────────────────────────────────────────────────
tmux attach-session -t "$SESSION"
