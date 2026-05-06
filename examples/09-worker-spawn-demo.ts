import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { spawnWorker } from '@agentx/harness-server';
import YAML from 'yaml';

/**
 * Per-job worker spawn demo: proves the F18/F24/F25 chain.
 *
 *   harness submit → spawnWorker:
 *     1. clone (or reuse) bare repo at .harness/repos/<name>.git
 *     2. git worktree add .harness/wt/<jobId>/main/<repo> (branch agent/<jobId>)
 *     3. emit per-job devcontainer override-config that mounts each worktree
 *        at /workspace/<repo>/ inside the container
 *
 * The container is NOT actually launched here — that needs Docker +
 * @devcontainers/cli. We print the `devcontainer up` command at the end.
 */
const workspaceRoot = process.cwd();
const yamlPath = join(workspaceRoot, 'harness-workspace.yml');
const workspaceConfig = YAML.parse(await readFile(yamlPath, 'utf8')) as {
  workspace: {
    products: Array<{
      id: string;
      repos: Array<{ name: string; cloneUrl: string; baseRef?: string; path?: string }>;
    }>;
  };
};

const product = workspaceConfig.workspace.products.find((p) => p.id === 'skoolscout-com');
if (!product) {
  console.error('skoolscout-com product not found in harness-workspace.yml');
  process.exit(1);
}

console.log('=== Per-job worker spawn demo ===\n');
console.log(`Product: ${product.id}`);
console.log(`Repos:   ${product.repos.map((r) => r.name).join(', ')}\n`);

const jobId = `job_${randomUUID().slice(0, 8)}`;
console.log(`▶ Simulated submit: feature-add for ${product.id} (jobId=${jobId})\n`);

console.log('▶ Spawning worker artifacts (clone bare → worktree add → override config)\n');

const result = await spawnWorker({
  jobId,
  productId: product.id,
  pipeline: 'feature-add',
  name: 'Office Hours',
  repos: product.repos,
  workspaceRoot,
});

console.log('\n✓ Worker spawn artifacts ready:');
console.log(`  Container name:  ${result.containerName}`);
console.log(`  Subagent:        ${result.subagentId}`);
console.log(`  Worktrees (${result.worktrees.length}):`);
for (const wt of result.worktrees) {
  const status = wt.cloned ? 'cloned' : `placeholder (${wt.placeholder ?? 'no clone'})`;
  console.log(`    - ${wt.repo.padEnd(20)} branch=${wt.branch.padEnd(28)} ${status}`);
  console.log(`      host:      ${relative(workspaceRoot, wt.path)}`);
  console.log(`      container: ${wt.containerPath}`);
}
console.log(`  Override config: ${relative(workspaceRoot, result.overrideConfigPath)}`);

console.log('\n▶ On-disk structure now under .harness/');
console.log(await tree(join(workspaceRoot, '.harness'), 4));

console.log('\n▶ devcontainer command that would launch the worker:\n');
console.log(`  ${result.spawnCommand}\n`);

console.log('Inside that container the agent sees:');
for (const wt of result.worktrees) {
  console.log(`  ${wt.containerPath}/   (= host ${relative(workspaceRoot, wt.path)}/)`);
}
console.log('  /root/.harness/run/{harness,memory,context}.sock   (always-on triad)');
console.log('');
console.log('All three trust gates still apply (decision #5):');
console.log('  - Worktree dir mode 0700 (set by mkdir)');
console.log('  - UDS sockets mode 0600 (set by each peer-server start)');
console.log('  - auth.json mode 0600 (FileBroker enforces; mounted from host ~/.agentx/)');

async function tree(dir: string, maxDepth: number, prefix = '', depth = 0): Promise<string> {
  if (depth >= maxDepth) return '';
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  let out = '';
  const visible = entries
    .filter((e) => !e.name.startsWith('.git') || e.name === '.gitkeep')
    .sort((a, b) => a.name.localeCompare(b.name));
  for (let i = 0; i < visible.length; i++) {
    const e = visible[i]!;
    const isLast = i === visible.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    out += `${prefix}${connector}${e.name}${e.isDirectory() ? '/' : ''}\n`;
    if (e.isDirectory()) {
      const sub = await tree(
        join(dir, e.name),
        maxDepth,
        prefix + (isLast ? '    ' : '│   '),
        depth + 1,
      );
      out += sub;
    }
  }
  return out;
}
