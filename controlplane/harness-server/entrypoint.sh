#!/bin/bash
# harness-server entrypoint — execs the bun launcher.

set -euo pipefail

echo "[harness-server] starting via bun launcher…"
exec bun /opt/harness/launcher.js
