/**
 * Live validation of the slice 9d-2 / 9d-5 / 9d-6 spawn-worker chain
 * against a real GitHub repo (skoolscout-com).
 *
 * What this exercises:
 *   - spawnWorker invokes `git clone --bare` against a real GitHub
 *     HTTPS URL (auth via Git Credential Manager / gh token).
 *   - Override-config is generated with worktree + .harness/run mounts.
 *   - On second call, cache hit → `git fetch origin` refreshes the
 *     bare repo (slice 9d-2 staleness fix).
 *   - baseRef is captured (the commit the per-job branch was rooted
 *     at).
 *   - SSH agent forwarding option produces the right override-config
 *     mount + containerEnv (slice 9d-6).
 *
 * What this does NOT do:
 *   - Actually run `devcontainer up` (needs @devcontainers/cli on
 *     PATH; install via `npm install -g @devcontainers/cli`).
 *   - Run any LLM agents inside the container.
 *
 * Cleanup: deletes the entire temp workspace at exit (the scratch
 * area lives in OS tmpdir; never touches your actual .harness/).
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnWorker } from '@agentx/harness-server';

// SSH URL — repo is INTERNAL (org-only). HTTPS clone via GCM would need
// the credential helper to carry an org-scoped token; SSH agent (already
// loaded with the user's ed25519 key) is the path of least resistance.
const REPO_URL = 'git@github.com:skoolscout/skoolscout-com.git';
const PRODUCT_ID = 'skoolscout-com';
const PIPELINE = 'feature-add';

console.log('=== Live validation: slice 9d spawn-worker ===');
console.log(`Repo: ${REPO_URL}`);
console.log(`SSH agent: ${process.env.SSH_AUTH_SOCK ? 'loaded' : 'not loaded'}`);
console.log('');

const wsRoot = await mkdtemp(join(tmpdir(), 'agentx-9d-live-'));
console.log(`Workspace (temp): ${wsRoot}\n`);

try {
  // ── Run 1: cache miss → bare clone ──────────────────────────────────────
  const jobId1 = `live_${randomUUID().slice(0, 8)}`;
  console.log(`[Run 1] jobId=${jobId1} (expect: cache miss + clone)`);
  const t1 = Date.now();
  const r1 = await spawnWorker({
    jobId: jobId1,
    productId: PRODUCT_ID,
    pipeline: PIPELINE,
    workspaceRoot: wsRoot,
    repos: [{ name: 'skoolscout-com', cloneUrl: REPO_URL, path: '/workspace/skoolscout-com' }],
    forwardSshAgent: process.env.SSH_AUTH_SOCK ? true : false,
  });
  const t1Ms = Date.now() - t1;

  const w1 = r1.worktrees[0]!;
  console.log(`  freshlyCloned: ${w1.freshlyCloned}  refreshed: ${w1.refreshed}`);
  console.log(`  branch:        ${w1.branch}`);
  console.log(`  baseRef:       ${w1.baseRef ?? '(not captured)'}`);
  console.log(`  worktree path: ${w1.path}`);
  console.log(`  duration:      ${t1Ms}ms`);
  if (w1.placeholder) {
    console.log(`  ⚠ placeholder: ${w1.placeholder}`);
  }
  console.log('');

  if (!w1.freshlyCloned) {
    console.error(`  ❌ Expected freshlyCloned=true on first run (placeholder: ${w1.placeholder ?? 'none'})`);
    process.exit(1);
  }
  if (!w1.baseRef || !/^[a-f0-9]{40}$/.test(w1.baseRef)) {
    console.error(`  ❌ Expected baseRef to be a 40-char SHA, got: ${w1.baseRef}`);
    process.exit(1);
  }
  console.log('  ✓ Run 1 ok\n');

  // ── Run 2: cache hit → git fetch (slice 9d-2 staleness fix) ────────────
  const jobId2 = `live_${randomUUID().slice(0, 8)}`;
  console.log(`[Run 2] jobId=${jobId2} (expect: cache hit + fetch)`);
  const t2 = Date.now();
  const r2 = await spawnWorker({
    jobId: jobId2,
    productId: PRODUCT_ID,
    pipeline: PIPELINE,
    workspaceRoot: wsRoot,
    repos: [{ name: 'skoolscout-com', cloneUrl: REPO_URL }],
    forwardSshAgent: process.env.SSH_AUTH_SOCK ? true : false,
  });
  const t2Ms = Date.now() - t2;

  const w2 = r2.worktrees[0]!;
  console.log(`  freshlyCloned: ${w2.freshlyCloned}  refreshed: ${w2.refreshed}`);
  console.log(`  branch:        ${w2.branch}`);
  console.log(`  baseRef:       ${w2.baseRef ?? '(not captured)'}`);
  console.log(`  duration:      ${t2Ms}ms (vs Run 1: ${t1Ms}ms — faster = cache works)\n`);

  if (w2.freshlyCloned) {
    console.error('  ❌ Expected freshlyCloned=false on second run');
    process.exit(1);
  }
  if (!w2.refreshed) {
    console.error('  ❌ Expected refreshed=true on cache hit');
    process.exit(1);
  }
  if (w2.baseRef !== w1.baseRef) {
    console.warn(`  ⚠ baseRef changed between runs (${w1.baseRef} → ${w2.baseRef}) — main got new commits during validation`);
  }
  console.log('  ✓ Run 2 ok\n');

  // ── Verify override-config shape ───────────────────────────────────────
  console.log('[Override config]');
  const cfg = JSON.parse(await readFile(r2.overrideConfigPath, 'utf8'));
  console.log(`  containerName: ${cfg.name}`);
  console.log(`  image:         ${cfg.image}`);
  console.log(`  mounts:        ${cfg.mounts.length}`);
  for (const m of cfg.mounts) console.log(`    - ${m}`);
  console.log(`  containerEnv:  ${Object.keys(cfg.containerEnv).join(', ')}`);
  console.log(`  spawnCommand:  ${r2.spawnCommand}\n`);

  if (process.env.SSH_AUTH_SOCK) {
    if (!cfg.mounts.some((m: string) => m.includes('ssh-agent'))) {
      console.error('  ❌ Expected SSH agent mount when SSH_AUTH_SOCK is set');
      process.exit(1);
    }
    if (cfg.containerEnv.SSH_AUTH_SOCK !== '/ssh-agent.sock') {
      console.error(`  ❌ Expected containerEnv.SSH_AUTH_SOCK=/ssh-agent.sock, got: ${cfg.containerEnv.SSH_AUTH_SOCK}`);
      process.exit(1);
    }
    console.log('  ✓ SSH agent forwarding configured correctly\n');
  }

  console.log('═══════════════════════════════════════════');
  console.log('✓ LIVE VALIDATION PASSED');
  console.log('═══════════════════════════════════════════');
  console.log('');
  console.log('Next step (Layer 2 — full container path):');
  console.log('  npm install -g @devcontainers/cli');
  console.log('  Build the worker image, then run runWorker against this spec.');
} finally {
  await rm(wsRoot, { recursive: true, force: true });
}
