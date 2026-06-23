# Bug report — Pencil: duplicate node `id` crashes the loader; document opens EMPTY (data-loss scare)

## Environment
- **Pencil** 1.1.64 (Electron 42.2.0)
- macOS (Darwin 25.3.0)
- Editing via the Pencil **MCP / agent integration** using **concurrent agents** (`spawn_agents` → parallel `batch_design` inserts)
- File: `control-plane-v1.pen`, ~3.15 MB, schema `2.13`, 41 top-level nodes, 64 reusable components

## Summary
A `.pen` file became unopenable — Pencil showed **"Failed to open control-plane-v1.pen"** and the editor fell back to an **empty document (0 nodes, 0 components)**, implying total loss of hours of work. In reality the file on disk was **valid JSON and fully intact**. Root cause: a **single duplicate node `id`** in the document tree. The loader crashes on the ID collision (Crashpad → Sentry). Removing that one node restored the file; nothing else was wrong.

## Root cause
Exactly one duplicate `id` out of 3,531 nodes. A phantom, **disabled** `ref` instance had been written to the document root with the **same `id` as the master component it points to**:

```jsonc
// index 31 — the corrupt artifact (note id === ref === the component's id)
{ "type": "ref",   "id": "INHrn", "ref": "INHrn", "enabled": false, "x": -4603, "y": -2668, "descendants": { /* 1 key */ } }
// index 32 — the legitimate component
{ "type": "frame", "id": "INHrn", "name": "main{WithSideNavAndActivityBar}", "reusable": true, "children": [ /* 4 */ ] }
```

A correct, distinctly-id'd instance of the same component already existed elsewhere (`{type:"ref", id:"B7cGA2", ref:"INHrn"}`), so the artifact was a **redundant phantom** — consistent with a partial/duplicate insert produced during **concurrent agent editing** (multiple designer agents inserting into the same frame; previously also seen as phantom "No parent" partial-commit inserts).

## Two distinct defects
1. **Writer / data integrity:** concurrent edits can **persist a node whose `id` duplicates an existing node's `id`.** Node IDs must be globally unique; the editor/writer (and the concurrent-insert path) should never emit a collision.
2. **Loader resilience:** a single duplicate `id` makes the **entire document fail to open**, and the editor silently falls back to an **empty doc with no warning and no in-app recovery.** Critically, that empty editor **stays bound to the file path and can autosave the empty document over the good file** — turning a fully-recoverable condition into real data loss.

## Steps to reproduce (observed)
1. Open a large `.pen` in Pencil with the MCP/agent integration.
2. Run concurrent edits via `spawn_agents` (several agents inserting into the same container).
3. Reopen the file → **"Failed to open"**; editor shows an empty document.

## Minimal reproduction (synthetic)
1. Any document with a reusable component `C` (`id: "C"`).
2. Add a sibling `ref`: `{ "type":"ref", "id":"C", "ref":"C", "enabled":false }` (id collides with its own target).
3. Save, reopen → loader fails / empty canvas.

## Expected
- Writer never produces a duplicate `id`.
- On encountering a duplicate `id` at load, **degrade gracefully**: reassign a fresh id (or skip the offending node), show a **non-fatal warning** ("duplicate node id `X` — N nodes recovered"), and **still load the rest**.
- **Never autosave an empty/failed-load editor over the source file.**

## Actual
- Hard "Failed to open"; blank canvas; the good 3.15 MB file is left at risk of being overwritten by the empty editor.

## Impact — High
Looks like catastrophic loss of work. Recovery required **external tooling**: the app couldn't open the file, and the MCP tools operate only on the **in-memory editor** (they ignore the supplied `filePath` for disk content), so they could neither read nor repair the file on disk.

## Workaround (verified)
1. Don't let Pencil autosave the empty doc; **back up the `.pen` immediately**.
2. Scan the JSON for duplicate `id`s (every node, recursively).
3. Remove the phantom (or reassign its id); re-validate (0 duplicate ids, 0 broken refs).
4. Re-serialize with the same formatting (2-space indent, `ensure_ascii=false`, no trailing newline → byte-compatible with Pencil's own save; the fix is a clean 18-line diff).
5. **Restart Pencil** so it reloads the repaired file from disk (a running instance keeps the stale empty doc; `open`-ing the file again won't force a reload).

## Suggested fixes
1. Enforce globally-unique `id`s at write time and in the concurrent-insert path (reject/reassign on collision).
2. Make the loader tolerant of duplicate `id`s (reassign/skip + warn, load the remainder).
3. Guard autosave when a document failed to load or is empty-due-to-error, so it can't clobber the source file.
4. Replace the blank-canvas failure with an explicit, actionable error.
