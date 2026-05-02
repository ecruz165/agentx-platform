#!/usr/bin/env bash
# scripts/dev-tmux.sh — launch the agentx ops dashboard in tmux.
#
# Layout (single window "dash"):
#   ┌───────────────────────┬──────────────────────┐
#   │  TUI (interactive)    │ harness-server logs  │
#   │  - auth status        ├──────────────────────┤
#   │  - login              │ memory-server logs   │
#   │  - intent submit      ├──────────────────────┤
#   │  - recent jobs        │ context-server logs  │
#   ├───────────────────────┤                      │
#   │  ops shell ($)        │                      │
#   │  free-form commands   │                      │
#   └───────────────────────┴──────────────────────┘
#
# Shell pane height: AGENTX_SHELL_LINES (default 12).
#
# Idempotent: if the session exists, attach to it instead of recreating.
# Override the session name with AGENTX_TMUX_SESSION=foo scripts/dev-tmux.sh.
# Tear down with `pnpm tmux:down` (sends SIGHUP to all panes; main.ts handles it).

set -euo pipefail

SESSION="${AGENTX_TMUX_SESSION:-agentx}"
SHELL_LINES="${AGENTX_SHELL_LINES:-12}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_DIR="$WS_ROOT/.harness/run"

mkdir -p "$RUN_DIR"
# Clear stale sockets (if a previous session was killed without graceful shutdown).
rm -f "$RUN_DIR"/*.sock

if tmux has-session -t "$SESSION" 2>/dev/null; then
  # Session exists — but make sure it isn't a dead carcass (the trio processes
  # inside might have been killed externally, leaving shell prompts but no
  # working servers). Heuristic: if no trio processes are alive on the host,
  # the session is stale; kill it and rebuild.
  if pgrep -f "tsx packages/[^/]*/src/main\.ts" >/dev/null 2>&1 \
     || pgrep -f "tsx examples/04-server-trio\.ts" >/dev/null 2>&1; then
    echo "Session '$SESSION' already running — attaching."
    exec tmux attach -t "$SESSION"
  else
    echo "Session '$SESSION' exists but its trio processes are dead — recreating."
    tmux kill-session -t "$SESSION" 2>/dev/null || true
  fi
fi

# Reap any orphan trio processes from a prior run that was torn down with
# pkill -9 (SIGKILL is uncatchable, so SIGHUP cleanup didn't fire). Makes
# 'pnpm tmux' always idempotent — new panes' servers can bind without
# colliding with zombies.
pkill -f "tsx packages/[^/]*/src/main\.ts" 2>/dev/null || true
pkill -f "tsx examples/04-server-trio\.ts" 2>/dev/null || true
sleep 0.3

echo "Starting tmux session '$SESSION' (workspace: $WS_ROOT)…"

# Pane 0 (left, full height) — interactive TUI
tmux new-session -d -s "$SESSION" -n dash -c "$WS_ROOT"
tmux send-keys -t "${SESSION}:dash.0" "pnpm --silent harness tui" C-m

# Pane 1 (right column, top) — harness-server
tmux split-window -h -t "${SESSION}:dash.0" -c "$WS_ROOT"
tmux send-keys -t "${SESSION}:dash.1" \
  "HARNESS_SOCKET_PATH='$RUN_DIR/harness.sock' pnpm --silent --filter @agentx/harness-server exec tsx src/main.ts" C-m

# Pane 2 (right column, middle) — edge-memory-server
tmux split-window -v -t "${SESSION}:dash.1" -c "$WS_ROOT"
tmux send-keys -t "${SESSION}:dash.2" \
  "MEMORY_SOCKET_PATH='$RUN_DIR/memory.sock' pnpm --silent --filter @agentx/edge-memory-server exec tsx src/main.ts" C-m

# Pane 3 (right column, bottom) — edge-context-server
tmux split-window -v -t "${SESSION}:dash.2" -c "$WS_ROOT"
tmux send-keys -t "${SESSION}:dash.3" \
  "CONTEXT_SOCKET_PATH='$RUN_DIR/context.sock' pnpm --silent --filter @agentx/edge-context-server exec tsx src/main.ts" C-m

# main-vertical: pane 0 takes the full left column, the others stack on the right.
tmux select-layout -t "${SESSION}:dash" main-vertical

# Split the left column horizontally — TUI on top, an ops shell below.
# Capturing the new pane id (-P -F '#{pane_id}') is more robust than guessing
# pane indexes after layout reshuffles.
SHELL_PANE=$(tmux split-window -v -l "$SHELL_LINES" -t "${SESSION}:dash.0" -c "$WS_ROOT" -P -F '#{pane_id}')
tmux send-keys -t "$SHELL_PANE" \
  "clear && echo 'agentx ops shell — pnpm harness <verb>  |  pnpm dev:*  |  cat scripts/dev-tmux-hints.txt'" C-m

# Optional second window — plain shell that opens with the cheat sheet visible.
tmux new-window -t "$SESSION" -n hints -c "$WS_ROOT"
tmux send-keys -t "${SESSION}:hints" "clear && cat '$SCRIPT_DIR/dev-tmux-hints.txt'" C-m

# ── Hotkeys: prefix-J opens the 3-column jobs viewer in a new window;
# prefix-M jumps back to the main dash window. The tmux server keeps these
# bindings until it dies; pnpm tmux re-installs them every launch.
tmux bind-key J new-window -t "${SESSION}" -n jobs -c "$WS_ROOT" \
  "pnpm --silent harness jobs-tui"
tmux bind-key M select-window -t "${SESSION}:dash"

# Land on the dashboard window with the TUI focused (not the new shell pane).
tmux select-window -t "${SESSION}:dash"
tmux select-pane -t "${SESSION}:dash.0"
exec tmux attach -t "$SESSION"
