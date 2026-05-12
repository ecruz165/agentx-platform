#!/usr/bin/env bash
# scripts/smoke-gate1.sh — Gate 1 end-to-end local-Docker smoke.
#
# What it does:
#   1. Submits a job via `harness submit --product <id> "<change>"`
#   2. Polls `docker ps -a --filter label=harness-job-id=<jobId>` until
#      the worker container appears (or timeout).
#   3. Asserts the container has the expected per-repo bind mount at
#      /workspace/<repoName> sourced from
#      <workspaceRoot>/.harness/wt/<jobId>/<subagent>/<repoName>.
#   4. Optionally reaps the container + worktree on exit (--cleanup).
#
# Prerequisites:
#   - harness-server running and listening on <workspace>/.harness/run/harness.sock
#     (start with: pnpm dev:harness, or via scripts/dev-tmux.sh)
#   - AGENTX_USE_CONTAINER=1 set on the harness-server (controls the
#     container path vs in-process path)
#   - Worker image built: `docker build -t agentx/worker:0.0.0 workspace-template/.devcontainer/worker`
#
# Exit codes: 0 success, 1 assertion failure, 2 usage error, 3 timeout

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PRODUCT="${SMOKE_PRODUCT:-agentx-dev}"
CHANGE="${SMOKE_CHANGE:-Gate 1 smoke: no-op verification}"
TIMEOUT_S="${SMOKE_TIMEOUT:-60}"
DO_CLEANUP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --product) PRODUCT="$2"; shift 2 ;;
    --change) CHANGE="$2"; shift 2 ;;
    --timeout) TIMEOUT_S="$2"; shift 2 ;;
    --cleanup) DO_CLEANUP=1; shift ;;
    -h|--help)
      sed -n '2,21p' "$0"
      exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[36m[smoke]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[smoke FAIL]\033[0m %s\n' "$*" >&2; exit "${2:-1}"; }
ok()   { printf '\033[32m[smoke OK]\033[0m %s\n' "$*"; }

# Pre-flight: harness-server reachable?
HARNESS_SOCK="$WS_ROOT/.harness/run/harness.sock"
if [[ ! -S "$HARNESS_SOCK" ]]; then
  fail "harness-server socket not found at $HARNESS_SOCK — start harness-server first" 2
fi

# Pre-flight: docker daemon reachable?
if ! docker info >/dev/null 2>&1; then
  fail "docker daemon not reachable" 2
fi

log "submitting job: product=$PRODUCT change=\"$CHANGE\""
SUBMIT_OUT="$(cd "$WS_ROOT" && pnpm --silent --filter @ecruz165/harness exec tsx packages/harness-cli/src/index.ts submit "$CHANGE" --product "$PRODUCT" 2>&1)"
echo "$SUBMIT_OUT"

# Extract jobId — `handleSubmit` logs it as the first token on
# "Submitting <jobId> [(name)] to harness-server …".
JOB_ID="$(printf '%s\n' "$SUBMIT_OUT" | sed -n 's/^Submitting \(job_[a-z0-9]\{1,\}\).*/\1/p' | head -n1)"
if [[ -z "$JOB_ID" ]]; then
  fail "could not extract jobId from harness submit output"
fi
log "jobId: $JOB_ID"

# Poll docker for the worker container with this jobId label.
log "polling docker for container labeled harness-job-id=$JOB_ID (timeout ${TIMEOUT_S}s)…"
DEADLINE=$(( $(date +%s) + TIMEOUT_S ))
CONTAINER_ID=""
while (( $(date +%s) < DEADLINE )); do
  CONTAINER_ID="$(docker ps -a --filter "label=harness-job-id=$JOB_ID" --format '{{.ID}}' | head -n1)"
  if [[ -n "$CONTAINER_ID" ]]; then break; fi
  sleep 1
done
if [[ -z "$CONTAINER_ID" ]]; then
  fail "timeout: no container with label harness-job-id=$JOB_ID after ${TIMEOUT_S}s" 3
fi
ok "container appeared: $CONTAINER_ID"

# Assert the per-repo bind mount(s) exist with the expected source path.
log "asserting bind mounts…"
MOUNTS_JSON="$(docker inspect --format '{{json .Mounts}}' "$CONTAINER_ID")"
EXPECTED_SRC_PREFIX="$WS_ROOT/.harness/wt/$JOB_ID/"
echo "$MOUNTS_JSON" | python3 -c "
import json, sys, os
mounts = json.load(sys.stdin)
prefix = os.environ['EXPECTED_SRC_PREFIX']
matches = [m for m in mounts if m.get('Source', '').startswith(prefix) and m.get('Destination', '').startswith('/workspace/')]
if not matches:
    print(f'no worktree-shaped mounts under {prefix!r} → /workspace/<repo>', file=sys.stderr)
    print(json.dumps(mounts, indent=2), file=sys.stderr)
    sys.exit(1)
for m in matches:
    print(f'  {m[\"Source\"]} -> {m[\"Destination\"]}')
" EXPECTED_SRC_PREFIX="$EXPECTED_SRC_PREFIX" || fail "mount assertion failed"
ok "expected worktree mount(s) present"

# Container is up + mounted correctly → Gate 1 smoke passes.
ok "Gate 1 smoke complete (jobId=$JOB_ID container=$CONTAINER_ID)"

if (( DO_CLEANUP )); then
  log "reaping…"
  (cd "$WS_ROOT" && pnpm --silent --filter @ecruz165/harness exec tsx packages/harness-cli/src/index.ts reap --job "$JOB_ID" --force)
fi
