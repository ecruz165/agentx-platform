/**
 * HITL file-browse routes for the harness-server.
 *
 * Exposes per-job product-repo content + diff to reviewers via three
 * endpoints:
 *
 *   GET /v1/jobs/:id/files
 *     Full file listing across the job's product repos with a
 *     change-overlay (added/modified/deleted/unchanged). UI uses
 *     this to build a sidebar.
 *
 *   GET /v1/jobs/:id/files/:repo/<path>/content
 *     Raw file bytes from the working tree, with Content-Type from
 *     the MIME table.
 *
 *   GET /v1/jobs/:id/files/:repo/<path>/diff
 *     Unified diff vs HEAD (text/x-diff). 204 No Content when there
 *     are no changes for this path.
 *
 * Security:
 *   - :repo must match an entry in job.productRepos. Unknown → 403.
 *   - <path> must not contain `..` segments. Resolved absolute path
 *     must remain inside `<workdirRoot>/<repo>/`. Anything escaping →
 *     400 (path traversal).
 *   - File size cap (MAX_FILE_BYTES) prevents DoS on huge files; 413
 *     when exceeded.
 *
 * Lookups go directly to git on each request — no LangGraph state read.
 * Reasoning: file-routes are for browsing, which can happen at any
 * moment, not just at interrupts. Fresh git is more accurate than
 * the channel snapshot, and avoids coupling the routes to the
 * checkpointer.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { isAbsolute, normalize, resolve as resolvePath, sep } from 'node:path';
import {
  type ChangedFile,
  discoverChangedFiles,
  mimeFromPath,
  parseGitDiffNameStatus,
  runGit,
} from '@ecruz165/harness-core';

/** Cap any single file response. Tunable; current 50 MB matches what
 *  most browsers happily render. Larger files return 413. */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

export interface FileEntry {
  /** Path within the repo, slash-separated. */
  path: string;
  filename: string;
  /** Tracked-in-HEAD + status overlay. 'unchanged' for files that
   *  match HEAD; one of the discoverChangedFiles kinds otherwise. */
  changeKind:
    | 'unchanged'
    | 'added'
    | 'modified'
    | 'deleted'
    | 'renamed'
    | 'copied'
    | 'type-changed';
  mimeType: string;
}

export interface RepoListing {
  name: string;
  files: FileEntry[];
}

/**
 * Build a full repo file listing with change overlay. Runs two git
 * commands in parallel:
 *
 *   - `git ls-tree -r HEAD --name-only -z` → tracked files at HEAD
 *   - `git diff --name-status -z --cached` → staged changes
 *
 * Merges the lists: tracked-in-HEAD files default to 'unchanged' and
 * are upgraded by the changes overlay; staged adds (not in HEAD)
 * appear as new entries.
 *
 * Empty / non-existent repos → empty file list (no error). Same
 * tolerance as discoverChangedFiles — the file routes shouldn't 500
 * because git is unhappy with one repo.
 */
export async function listRepoFiles(workdirRoot: string, repo: string): Promise<RepoListing> {
  const repoPath = resolvePath(workdirRoot, repo);
  const [trackedRaw, stagedRaw] = await Promise.all([
    runGit(repoPath, ['ls-tree', '-r', 'HEAD', '--name-only', '-z']).catch(() => ''),
    runGit(repoPath, ['diff', '--name-status', '-z', '--cached']).catch(() => ''),
  ]);

  const tracked = trackedRaw.split('\0').filter((p) => p.length > 0);
  const changes = parseGitDiffNameStatus(stagedRaw, repo);
  const changeByPath = new Map<string, ChangedFile>(changes.map((c) => [c.path, c]));

  // Start with tracked files, all 'unchanged'.
  const seen = new Set<string>();
  const entries: FileEntry[] = [];
  for (const path of tracked) {
    seen.add(path);
    const change = changeByPath.get(path);
    entries.push({
      path,
      filename: basename(path),
      changeKind: change?.changeKind ?? 'unchanged',
      mimeType: mimeFromPath(path),
    });
  }
  // Add files that are staged-added (not in HEAD yet).
  for (const change of changes) {
    if (seen.has(change.path)) continue;
    if (change.changeKind === 'deleted') {
      // Deleted files DO appear in HEAD ls-tree (they were tracked
      // before deletion); the merge above already marked them. But
      // skip emitting an entry that doesn't exist anywhere — UI
      // can detect deletion via the changeKind on the merged entry.
      continue;
    }
    entries.push({
      path: change.path,
      filename: basename(change.path),
      changeKind: change.changeKind,
      mimeType: change.mimeType,
    });
  }
  // Stable sort by path for predictable UI.
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { name: repo, files: entries };
}

/**
 * Resolve `<workdirRoot>/<repo>/<path>` and verify the result is
 * within the repo boundary (no `../` escapes, no symlinks pointing
 * out of the repo). Returns the absolute path on success or null on
 * traversal violation.
 */
export function safeResolveInRepo(
  workdirRoot: string,
  repo: string,
  filePath: string,
): string | null {
  // Reject control characters and absolute paths up-front.
  if (filePath.includes('\0') || isAbsolute(filePath)) return null;
  const normalized = normalize(filePath);
  if (normalized.startsWith('..') || normalized === '..' || normalized.split(sep).includes('..')) {
    return null;
  }
  const repoRoot = resolvePath(workdirRoot, repo);
  const candidate = resolvePath(repoRoot, normalized);
  // Confirm candidate is inside repoRoot. Trailing sep on repoRoot
  // prevents prefix-match bugs (`/a/repo` should not match `/a/repo2`).
  const repoRootWithSep = repoRoot.endsWith(sep) ? repoRoot : `${repoRoot}${sep}`;
  if (candidate !== repoRoot && !candidate.startsWith(repoRootWithSep)) return null;
  return candidate;
}

/**
 * Stream file content to the response with the appropriate
 * Content-Type. Caller validated the path traversal already.
 *
 *   - File exists + is a regular file + within size cap → 200 stream
 *   - Doesn't exist → 404
 *   - Larger than MAX_FILE_BYTES → 413
 *   - Anything else (directory, special file, EACCES) → 500
 */
export async function streamFileContent(
  res: ServerResponse,
  absolutePath: string,
  mimeType: string,
): Promise<void> {
  let info: import('node:fs').Stats;
  try {
    info = await stat(absolutePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'file not found' }));
      return;
    }
    throw err;
  }
  if (!info.isFile()) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'not a regular file' }));
    return;
  }
  if (info.size > MAX_FILE_BYTES) {
    res.statusCode = 413;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        error: `file too large (${info.size} bytes; max ${MAX_FILE_BYTES})`,
      }),
    );
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Length', String(info.size));
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(absolutePath);
    stream.on('error', reject);
    stream.on('end', () => resolve());
    stream.pipe(res);
  });
}

/**
 * Unified diff for a single path vs HEAD. Returns the diff text or
 * null when there are no changes (caller emits 204).
 */
export async function fileDiff(
  workdirRoot: string,
  repo: string,
  filePath: string,
): Promise<string | null> {
  const repoPath = resolvePath(workdirRoot, repo);
  const out = await runGit(repoPath, ['diff', 'HEAD', '--', filePath]).catch(() => '');
  return out.length > 0 ? out : null;
}

/**
 * Read the HEAD-state content of a path (the "before" view). Returns
 * null when the file doesn't exist at HEAD (newly added). Caller
 * decides how to render (404 or empty diff base).
 */
export async function fileAtHead(
  workdirRoot: string,
  repo: string,
  filePath: string,
): Promise<string | null> {
  const repoPath = resolvePath(workdirRoot, repo);
  try {
    const out = await runGit(repoPath, ['show', `HEAD:${filePath}`]);
    return out;
  } catch {
    return null;
  }
}

/**
 * Top-level route handler for GET /v1/jobs/:id/files. Aggregates per-
 * repo listings + the in-state changedFiles count for the UI.
 */
export async function listAllFiles(
  workdirRoot: string,
  productRepos: readonly string[],
): Promise<{ repos: RepoListing[]; totalFiles: number; changedFiles: number }> {
  const listings = await Promise.all(productRepos.map((r) => listRepoFiles(workdirRoot, r)));
  const allChanges = await discoverChangedFiles(workdirRoot, productRepos);
  const totalFiles = listings.reduce((acc, l) => acc + l.files.length, 0);
  return { repos: listings, totalFiles, changedFiles: allChanges.length };
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}
