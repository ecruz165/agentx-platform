/**
 * Git-driven change discovery for HITL review surfaces.
 *
 * Approval / Suspend interrupts surface a list of "what changed" so the
 * reviewer can preview files before deciding. The convention: agents
 * `git add` the files they want reviewed; everything in the index is
 * fair game; unstaged changes are agent WIP and ignored.
 *
 * This module is the boundary between flow execution and git. It
 * spawns git as a child process — no in-process git library — to keep
 * the dep surface small and to defer to the canonical implementation
 * (which already handles every edge case: renames, copies, mode bits,
 * submodules, sparse checkouts, etc.).
 *
 * Path resolution: a `workdirRoot` + a list of repo names. Each repo
 * lives at `<workdirRoot>/<repoName>` and must contain a `.git` directory
 * (or be a submodule — git handles that). For in-process runJob,
 * workdirRoot === workspaceRoot. For the container path, workdirRoot
 * resolves to `<workspaceRoot>/.harness/wt/<jobId>` (the per-job
 * worktree).
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';

/**
 * One staged change in a product repo. Populated into `state.changedFiles`
 * before HITL interrupts; surfaced to reviewers via ApprovalRequest +
 * the harness-server file routes.
 *
 * The `id` is stable for the same `(repo, path)` within a job — UI
 * components can use it as a React key, content-cache identifier, etc.
 * Renames produce ONE entry with the new path + `previousPath` filled
 * in (matches `git diff --name-status -z` rename rows).
 */
export interface ChangedFile {
  /** Stable id: `${repo}::${path}`. Suitable for URL paths after
   *  encodeURIComponent. */
  id: string;
  /** Repo name (matches an entry from `productRepos` on the JobRecord). */
  repo: string;
  /** Path within the repo (slash-separated, no leading slash). */
  path: string;
  /** Basename of `path` — for UI display. */
  filename: string;
  /** What kind of change this is. Mirrors git's name-status codes
   *  collapsed to readable form. */
  changeKind: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type-changed';
  /** Raw git status code (e.g., 'M', 'A', 'D', 'R100'). Preserved for
   *  clients that want git-native semantics. */
  statusCode: string;
  /** For renames/copies, the prior path. Undefined otherwise. */
  previousPath?: string;
  /** MIME type guessed from the file extension. Hint for UI rendering;
   *  not authoritative — clients may sniff content if needed. */
  mimeType: string;
}

/**
 * Parse the output of `git diff --name-status -z --cached`. NUL-separated
 * because filenames may contain spaces, newlines, even tabs.
 *
 *   - status-only entries (M/A/D/T): `<status>\0<path>`
 *   - rename/copy entries (R/C with similarity %): `<status>\0<old>\0<new>`
 *
 * Multiple records run together with no terminator between them — the
 * NUL separates fields within a record AND between records. We pull
 * fields one at a time and decide record boundaries based on the leading
 * status code's first character.
 */
export function parseGitDiffNameStatus(stdout: string, repo: string): ChangedFile[] {
  const tokens = stdout.split('\0').filter((t) => t.length > 0);
  const out: ChangedFile[] = [];
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i]!;
    const lead = code.charAt(0);
    if (lead === 'R' || lead === 'C') {
      // R<sim>\0<old>\0<new>  or  C<sim>\0<old>\0<new>
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      if (oldPath === undefined || newPath === undefined) {
        // Malformed; skip this record. Defensive — git always emits
        // both for rename/copy but be safe.
        i += 1;
        continue;
      }
      out.push({
        id: `${repo}::${newPath}`,
        repo,
        path: newPath,
        filename: basename(newPath),
        changeKind: lead === 'R' ? 'renamed' : 'copied',
        statusCode: code,
        previousPath: oldPath,
        mimeType: mimeFromPath(newPath),
      });
      i += 3;
    } else {
      // Single-path record: M, A, D, T (type changed)
      const path = tokens[i + 1];
      if (path === undefined) {
        i += 1;
        continue;
      }
      out.push({
        id: `${repo}::${path}`,
        repo,
        path,
        filename: basename(path),
        changeKind: codeToKind(lead),
        statusCode: code,
        mimeType: mimeFromPath(path),
      });
      i += 2;
    }
  }
  return out;
}

function codeToKind(code: string): ChangedFile['changeKind'] {
  switch (code) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'T':
      return 'type-changed';
    default:
      return 'modified';
  }
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

/**
 * Discover staged changes across a list of product repos. Spawns one
 * `git diff --name-status -z --cached` per repo in parallel; concatenates
 * the results.
 *
 *   - Empty / non-existent repo dir → no entries (no error).
 *   - Repo with no staged changes → no entries.
 *   - Git command failure (corrupted repo, etc.) → entries from other
 *     repos are still returned; the failed repo silently contributes
 *     nothing. Logging is the caller's responsibility (we don't have a
 *     bus here).
 *
 * Performance: a clean-checkout `git diff --cached` is ~10ms even on
 * large repos. Parallel-per-repo keeps total latency at the slowest
 * single repo. Suitable for per-interrupt invocation.
 */
export async function discoverChangedFiles(
  workdirRoot: string,
  repoNames: readonly string[],
): Promise<ChangedFile[]> {
  if (repoNames.length === 0) return [];
  const perRepo = await Promise.all(
    repoNames.map(async (repo) => {
      const cwd = join(workdirRoot, repo);
      try {
        const stdout = await runGit(cwd, ['diff', '--name-status', '-z', '--cached']);
        return parseGitDiffNameStatus(stdout, repo);
      } catch {
        return [];
      }
    }),
  );
  return perRepo.flat();
}

/**
 * Spawn git with the given args in `cwd` and return stdout. Throws on
 * non-zero exit (caller in `discoverChangedFiles` swallows; other callers
 * may want the error). No shell — args are passed directly so paths
 * with spaces / special chars don't need escaping.
 */
export function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
  });
}

/**
 * Best-effort MIME type from filename extension. Used as a UI hint —
 * clients may sniff content for stronger guarantees. The set is
 * intentionally focused: text-formats reviewers commonly care about
 * (code, markdown, JSON, YAML), images, PDF, and a few diff-friendly
 * binary formats. Unknown extensions get `application/octet-stream`.
 */
export function mimeFromPath(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  const ext = path.slice(dot + 1).toLowerCase();
  switch (ext) {
    // Text / code
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'application/typescript';
    case 'py':
      return 'text/x-python';
    case 'rs':
      return 'text/x-rust';
    case 'go':
      return 'text/x-go';
    case 'java':
      return 'text/x-java';
    case 'rb':
      return 'text/x-ruby';
    case 'sh':
    case 'bash':
      return 'application/x-shellscript';
    case 'md':
    case 'markdown':
      return 'text/markdown';
    case 'json':
      return 'application/json';
    case 'yml':
    case 'yaml':
      return 'application/yaml';
    case 'toml':
      return 'application/toml';
    case 'xml':
      return 'application/xml';
    case 'html':
    case 'htm':
      return 'text/html';
    case 'css':
      return 'text/css';
    case 'txt':
    case 'log':
      return 'text/plain';
    case 'csv':
      return 'text/csv';
    case 'sql':
      return 'application/sql';
    // Images
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'svg':
      return 'image/svg+xml';
    case 'ico':
      return 'image/x-icon';
    // Documents
    case 'pdf':
      return 'application/pdf';
    case 'doc':
    case 'docx':
      return 'application/msword';
    // Archives / binaries
    case 'zip':
      return 'application/zip';
    case 'tar':
      return 'application/x-tar';
    case 'gz':
      return 'application/gzip';
    default:
      return 'application/octet-stream';
  }
}
