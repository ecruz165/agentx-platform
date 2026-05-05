/**
 * Recursive file walker. Returns relative paths matching the matcher.
 *
 * Phase B.0: synchronous-ish recursion via fs/promises; fine for v1 corpus
 * sizes (low thousands of files). Future optimization: parallel walks,
 * .gitignore awareness, content-hash early-skip.
 */

import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { MatcherFn } from './matcher.ts';

export interface WalkResult {
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
}

export interface WalkOptions {
  /** Root directory; relativePath in results is relative to this. */
  root: string;
  /** Matcher function; only files for which it returns true are emitted. */
  match: MatcherFn;
  /** Optional max files emitted (safety guard for huge trees). Default: no cap. */
  maxFiles?: number;
  /** Skip files larger than this. Default: no cap (matcher should set). */
  maxFileBytes?: number;
}

export async function* walk(opts: WalkOptions): AsyncIterable<WalkResult> {
  let count = 0;
  yield* walkDir(opts.root, opts);

  async function* walkDir(dir: string, o: WalkOptions): AsyncIterable<WalkResult> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // Directory not readable — skip silently. Matchers handle exclude lists
      // for typical cases; this catches permission errors and broken symlinks.
      return;
    }
    for (const entry of entries) {
      if (o.maxFiles && count >= o.maxFiles) return;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        // v1: always recurse. Per-file matching at the leaf handles excludes
        // correctly (e.g., a `**/node_modules/**` exclude still rejects every
        // file inside). Directory-level pruning was a perf optimization, but
        // the heuristic was unsound — it pruned valid subdirs whose paths
        // didn't happen to match the include pattern at the dir granularity.
        // Add picomatch + a real dir-level predicate when perf becomes a
        // concern; not before.
        yield* walkDir(abs, o);
      } else if (entry.isFile()) {
        const rel = relative(o.root, abs).replace(/\\/g, '/');
        if (!o.match(rel)) continue;
        let size = 0;
        try {
          const st = await stat(abs);
          size = st.size;
        } catch {
          continue;
        }
        if (o.maxFileBytes && size > o.maxFileBytes) continue;
        yield { relativePath: rel, absolutePath: abs, sizeBytes: size };
        count++;
      }
    }
  }
}
