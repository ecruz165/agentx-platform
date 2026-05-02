#!/usr/bin/env bash
# scripts/tmux-reset.sh — nuclear option for when the agentx tmux state is wedged.
#
# Kills the session, reaps any orphan trio processes (their PIDs survive even
# when their tmux panes have died), and clears stale UDS socket files.
#
# Usage:
#   pnpm tmux:reset      # then pnpm tmux for a fresh start

set -euo pipefail

SESSION="${AGENTX_TMUX_SESSION:-agentx}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_DIR="$WS_ROOT/.harness/run"

echo "→ killing tmux session '$SESSION' (if any)"
tmux kill-session -t "$SESSION" 2>/dev/null && echo "  killed" || echo "  (none)"

echo "→ reaping orphan trio processes"
pkill -f "tsx packages/[^/]*/src/main\.ts" 2>/dev/null && echo "  killed main.ts processes" || echo "  (no main.ts procs)"
pkill -f "tsx examples/04-server-trio\.ts" 2>/dev/null && echo "  killed dev:servers process" || echo "  (no dev:servers proc)"

sleep 0.5

echo "→ clearing stale sockets"
rm -f "$RUN_DIR"/*.sock 2>/dev/null
ls "$RUN_DIR"/*.sock >/dev/null 2>&1 && echo "  warn: sockets still present" || echo "  clean"

echo
echo "Reset complete. Run 'pnpm tmux' for a fresh start."
