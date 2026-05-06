/**
 * Procurement orchestrator.
 *
 * Sequence:
 *   1. validateRepoAccess (cheap; ls-remote per repo) — fail-fast before
 *      we touch the filesystem.
 *   2. mkdir <projectDir> (idempotent: refuse if non-empty unless --force).
 *   3. Copy workspace-template/ contents into <projectDir>.
 *   4. For each repo: `git clone <url> <projectDir>/<repoName>` — eager
 *      so the developer's working trees exist immediately.
 *   5. If any clone fails: roll back (rm -rf <projectDir>) so the next
 *      `agentx-workspace` invocation starts clean. The .code-workspace
 *      file is the success sentinel — it is NOT written on partial failure.
 *   6. Write <projectDir>/harness-workspace.yml from the substitution rule.
 *   7. Write <projectDir>/<name>.code-workspace.
 *   8. Return ProcureResult with absolute paths.
 *
 * Per-job worktrees are NOT populated here — those happen lazily inside
 * worker DevContainers via spawn-worker's bare-cache + git-worktree-add
 * flow when harness-server receives a job.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRepoAccess } from '@agentx/harness-server';
import { generateCodeWorkspace } from './code-workspace.ts';
import type { ProcureResult, ProcureSpec, RepoSpec } from './types.ts';
import { generateWorkspaceYml } from './yml.ts';

/** Locate workspace-template/ in the monorepo. Walks up from this file
 *  to find the directory; falls back to a CLI flag if relocated. */
function findWorkspaceTemplate(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  let dir = here;
  while (true) {
    const candidate = join(dir, 'workspace-template');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not locate workspace-template/ by walking up from ${here}`);
    }
    dir = parent;
  }
}

/** Resolve the toplevel git working tree containing `path`, or null if
 *  it isn't inside one. Walks up to the first existing ancestor before
 *  shelling out, since the workspace dest's parent may not exist yet.
 *  Exported for tests. */
export async function findEnclosingGitRepo(path: string): Promise<string | null> {
  let dir = resolve(path);
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return new Promise((resolveP) => {
    const child = spawn('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.on('error', () => resolveP(null));
    child.on('close', (code) => {
      resolveP(code === 0 ? stdout.trim() || null : null);
    });
  });
}

export async function procure(spec: ProcureSpec): Promise<ProcureResult> {
  const projectDir = isAbsolute(spec.dest) ? spec.dest : resolve(spec.dest);

  // Refuse to procure inside a git-managed project — would either pollute
  // the parent's working tree or create a nested repo. Workspaces must
  // sit alongside cloned repos in a non-tracked parent dir.
  const enclosing = await findEnclosingGitRepo(dirname(projectDir));
  if (enclosing) {
    throw new Error(
      `Cannot procure workspace inside a git-managed project.\n` +
        `  Target:   ${projectDir}\n` +
        `  Inside:   ${enclosing}\n` +
        `Workspaces should sit alongside cloned repos. cd to a non-tracked ` +
        `parent directory (e.g. ~/Development/Workspaces/) and try again.`,
    );
  }
  const result: ProcureResult = {
    ok: false,
    projectDir,
    repos: [],
  };

  // ── 1. Validate access (ls-remote each repo) ───────────────────────────
  const env = buildCloneEnv(spec.tokenEnv);
  const validation = await validateRepoAccess({
    repos: spec.repos.map((r) => ({ name: r.name, cloneUrl: r.cloneUrl })),
    cloneEnv: env,
    parallel: true,
  });

  result.repos = validation.all.map((c) => ({
    repo: spec.repos.find((r) => r.cloneUrl === c.repo.cloneUrl)!,
    cloned: false, // will be flipped after actual clone
    ...(c.head ? { head: c.head } : {}),
    ...(c.reason ? { reason: c.reason } : {}),
  }));

  if (validation.failures.length > 0) {
    return result; // ok stays false; caller can present per-repo errors
  }

  // ── 2. Create project dir ─────────────────────────────────────────────
  if (existsSync(projectDir)) {
    throw new Error(
      `Destination already exists: ${projectDir}\n` +
        `Refusing to overwrite. Pick a different --dest or remove the directory.`,
    );
  }
  await mkdir(projectDir, { recursive: true, mode: 0o755 });

  try {
    // ── 3. Copy workspace-template/ into projectDir ─────────────────────
    const templateDir = findWorkspaceTemplate();
    await cp(templateDir, projectDir, {
      recursive: true,
      // Skip the .example file — we generate the real one in step 6.
      filter: (src) => !src.endsWith('harness-workspace.yml.example'),
    });

    // ── 4. Eager clone each repo into projectDir/<repoName>/ ────────────
    if (!spec.noClone) {
      for (const repo of spec.repos) {
        const target = join(projectDir, repo.name);
        try {
          await runGitClone(repo.cloneUrl, target, env);
          const entry = result.repos.find((e) => e.repo.cloneUrl === repo.cloneUrl);
          if (entry) entry.cloned = true;
        } catch (err) {
          const entry = result.repos.find((e) => e.repo.cloneUrl === repo.cloneUrl);
          if (entry) {
            entry.cloned = false;
            entry.reason = (err as Error).message;
          }
          // Roll back the project dir so re-running is clean.
          await rm(projectDir, { recursive: true, force: true });
          return result;
        }
      }
    }

    // ── 5. Substitute + write harness-workspace.yml ─────────────────────
    const ymlContent = generateWorkspaceYml(spec);
    const ymlPath = join(projectDir, 'harness-workspace.yml');
    await writeFile(ymlPath, ymlContent, 'utf8');
    result.configFile = ymlPath;

    // ── 6. Write <name>.code-workspace ──────────────────────────────────
    const ws = generateCodeWorkspace(spec.name, spec.repos);
    const wsPath = join(projectDir, `${spec.name}.code-workspace`);
    await writeFile(wsPath, JSON.stringify(ws, null, 2), 'utf8');
    result.workspaceFile = wsPath;

    // ── 7. Optional: install skillzkit catalog items ────────────────────
    if (spec.skills && spec.skills.length > 0) {
      const skillzkitBin = spec.skillzkitBin ?? 'npx -y @ecruz165/skillzkit';
      const installResult = await runSkillzkitInstall(skillzkitBin, spec.skills, projectDir);
      result.skillsInstalled = {
        requested: spec.skills,
        exitCode: installResult.exitCode,
        ...(installResult.output ? { output: installResult.output } : {}),
      };
      // skillzkit failure is non-fatal: procurement is "done" once the
      // project tree + repos exist; the user can re-run skillzkit install
      // manually if it fails (e.g. GitHub Packages auth issue).
    }

    result.ok = true;
    return result;
  } catch (err) {
    await rm(projectDir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Spawn skillzkit's install subcommand. The bin string is split on
 * whitespace so callers can pass either a single binary
 * (`agentx-skillzkit`) or a multi-word command
 * (`npx -y @ecruz165/skillzkit`, `tsx /path/to/cli.ts`). Captures combined
 * output; truncates so ProcureResult.skillsInstalled.output stays small.
 */
function runSkillzkitInstall(
  binCommand: string,
  slugs: readonly string[],
  targetDir: string,
): Promise<{ exitCode: number; output?: string }> {
  return new Promise((resolveP) => {
    const parts = binCommand.split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      resolveP({ exitCode: 1, output: 'empty skillzkit-bin command' });
      return;
    }
    const [cmd, ...args] = parts as [string, ...string[]];
    const child = spawn(cmd, [...args, 'install', ...slugs, '--target', targetDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    child.stdout.on('data', (c) => (buf += c.toString()));
    child.stderr.on('data', (c) => (buf += c.toString()));
    child.on('error', (err) => {
      resolveP({ exitCode: 1, output: `failed to spawn: ${err.message}` });
    });
    child.on('close', (code) => {
      resolveP({
        exitCode: code ?? 1,
        output: buf.length > 4000 ? `${buf.slice(0, 4000)}\n…(truncated)` : buf,
      });
    });
  });
}

function buildCloneEnv(tokenEnv: string | undefined): NodeJS.ProcessEnv | undefined {
  if (!tokenEnv) return undefined;
  const token = process.env[tokenEnv];
  if (!token) return undefined;
  // GIT_ASKPASS-style injection via header. For HTTPS URLs only — SSH URLs
  // ignore this and fall through to ssh-agent.
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_HTTP_EXTRAHEADER: `Authorization: Bearer ${token}`,
  };
}

function runGitClone(
  url: string,
  target: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn('git', ['clone', url, target], {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('error', rejectP);
    child.on('close', (code) => {
      if (code === 0) resolveP();
      else rejectP(new Error(stderr.trim() || `git clone exited ${code}`));
    });
  });
}

/** Derive a short repo name from a clone URL when the user passes a bare URL.
 *  Used by bin.tsx + tui.tsx to build RepoSpec[] from raw input. */
export function repoNameFromUrl(url: string): string {
  // git@github.com:org/repo.git → repo
  // https://github.com/org/repo.git → repo
  // https://github.com/org/repo → repo
  // https://github.com/org → org   (org-only URL — caller should reject)
  const trimmed = url.replace(/\.git$/, '');
  const parts = trimmed.split(/[/:]/).filter(Boolean);
  return parts[parts.length - 1] ?? url;
}

/** Heuristic: does a URL look like an org-page URL rather than a repo URL? */
export function looksLikeOrgUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!u.hostname.includes('github.com')) return false;
    // github.com/<user-or-org> has exactly one path segment
    const segs = u.pathname.split('/').filter(Boolean);
    return segs.length === 1;
  } catch {
    return false;
  }
}

export function suggestRepoFromOrgUrl(url: string, productName: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, '')}/${productName}`;
  } catch {
    return url;
  }
}

export function specsFromCli(
  name: string | undefined,
  repos: readonly string[] | undefined,
  dest: string | undefined,
  tokenEnv: string | undefined,
  noClone: boolean,
  skills: readonly string[] | undefined,
  skillzkitBin: string | undefined,
): { spec: ProcureSpec | null; missing: string[]; orgUrls: string[] } {
  const missing: string[] = [];
  const orgUrls: string[] = [];

  if (!name) missing.push('name');
  if (!repos || repos.length === 0) missing.push('repos');

  for (const url of repos ?? []) {
    if (looksLikeOrgUrl(url)) orgUrls.push(url);
  }

  if (missing.length > 0 || orgUrls.length > 0) {
    return { spec: null, missing, orgUrls };
  }

  const repoSpecs: RepoSpec[] = (repos ?? []).map((url) => ({
    name: repoNameFromUrl(url),
    cloneUrl: url,
  }));

  const productName = name!;
  const destDir = dest ?? `./workspace-${productName}`;

  return {
    spec: {
      name: productName,
      repos: repoSpecs,
      dest: destDir,
      ...(tokenEnv ? { tokenEnv } : {}),
      noClone,
      ...(skills && skills.length > 0 ? { skills: [...skills] } : {}),
      ...(skillzkitBin ? { skillzkitBin } : {}),
    },
    missing: [],
    orgUrls: [],
  };
}
