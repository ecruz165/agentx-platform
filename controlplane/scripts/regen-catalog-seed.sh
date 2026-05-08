#!/usr/bin/env bash
# regen-catalog-seed.sh — walk an agentx-skillz catalog directory and emit
# a JSON array of normalized catalog items into
# controlplane/src/main/resources/seed-catalog-items.json. The Spring app
# loads that file on first startup (catalog_items table empty) to bootstrap
# the unified catalog.
#
# Usage:
#   AGENTX_SKILLZ_ROOT=/path/to/agentx-skillz ./regen-catalog-seed.sh
#   # default: ../../../agentx-skillz (sibling repo)
#
# Each <type>/<topic>/<id>/manifest.yaml becomes a JSON object:
#   {
#     "type": "skill",                 # singular (skill | workflow | prompt | persona | context | template)
#     "id": "ai/token-counter",        # path-derived slug, relative to catalog/<type>/
#     "name": "token-counter",         # from manifest
#     "version": "1.0.0",
#     "description": "...",
#     "topic": "ai",
#     "tags": ["ai", "tokens"],
#     "runtime": "go",
#     "manifest": { ...full manifest... }
#   }

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTROLPLANE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLATFORM_ROOT="$(cd "$CONTROLPLANE_DIR/.." && pwd)"
SKILLZ_ROOT="${AGENTX_SKILLZ_ROOT:-$PLATFORM_ROOT/../agentx-skillz}"

SEED_PATH="$CONTROLPLANE_DIR/src/main/resources/seed-catalog-items.json"

if [ ! -d "$SKILLZ_ROOT/catalog" ]; then
    echo "error: $SKILLZ_ROOT/catalog not found." >&2
    echo "set AGENTX_SKILLZ_ROOT to the agentx-skillz repo root." >&2
    exit 2
fi

echo "[regen] walking $SKILLZ_ROOT/catalog…"

# Use python3 (available cross-platform) to walk + parse YAML + emit JSON.
python3 - "$SKILLZ_ROOT/catalog" "$SEED_PATH" <<'PYEOF'
import json
import os
import sys
from pathlib import Path

# yaml is in stdlib? No. Try to use PyYAML; fall back to a tiny parser.
try:
    import yaml
except ImportError:
    print("error: PyYAML not installed. `pip3 install pyyaml`", file=sys.stderr)
    sys.exit(2)

catalog_root = Path(sys.argv[1])
seed_path = Path(sys.argv[2])

# Map directory name → singular type (per skillzkit's manifest convention).
DIR_TO_TYPE = {
    "skills": "skill",
    "workflows": "workflow",
    "prompts": "prompt",
    "personas": "persona",
    "context": "context",     # already singular
    "templates": "template",
}

items = []
for type_dir in sorted(catalog_root.iterdir()):
    if not type_dir.is_dir():
        continue
    item_type = DIR_TO_TYPE.get(type_dir.name)
    if not item_type:
        print(f"  skip: {type_dir.name} (not a known type)", file=sys.stderr)
        continue

    for manifest_path in sorted(type_dir.rglob("manifest.yaml")):
        relative = manifest_path.parent.relative_to(type_dir)
        slug = str(relative).replace(os.sep, "/")
        with manifest_path.open() as fh:
            manifest = yaml.safe_load(fh)
        if not isinstance(manifest, dict):
            print(f"  skip: {manifest_path} (not a dict)", file=sys.stderr)
            continue
        item = {
            "type": item_type,
            "id": slug,
            "name": manifest.get("name", slug),
            "version": manifest.get("version"),
            "description": manifest.get("description"),
            "topic": manifest.get("topic"),
            "tags": manifest.get("tags") or [],
            "runtime": manifest.get("runtime"),
            "manifest": manifest,
        }
        items.append(item)
        print(f"  + {item_type}/{slug}", file=sys.stderr)

with seed_path.open("w") as fh:
    json.dump(items, fh, indent=2, sort_keys=False)
    fh.write("\n")

print(f"[regen] wrote {len(items)} item(s) → {seed_path}", file=sys.stderr)
PYEOF
