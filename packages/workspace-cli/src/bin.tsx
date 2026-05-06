#!/usr/bin/env node
/**
 * agentx-workspace — procure a new agentx project from workspace-template/.
 *
 * Modes:
 *   - Non-interactive: all required args present + all repos valid → run
 *     procure() directly.
 *   - Interactive (TUI): any required arg missing OR any repo URL invalid →
 *     launch OpenTUI form prefilled with whatever IS valid; user fills the
 *     rest.
 *   - --no-tui: never launch TUI; fail-fast on missing/invalid input.
 */

import { Command } from 'commander';
import { procure, specsFromCli } from './procure.ts';
import { runTui } from './tui.tsx';
import type { ProcureSpec } from './types.ts';

const program = new Command()
  .name('agentx-workspace')
  .description('Procure a new agentx project folder from workspace-template/')
  .argument('[name]', 'Product name (positional shorthand for --name)')
  .option('--name <name>', 'Product name; doubles as workspace dir name + product id')
  .option(
    '--repos <urls...>',
    'Repository clone URLs (HTTPS or SSH). Repeatable; space-separated.'
  )
  .option('--dest <dir>', 'Destination directory (default: ./<name>)')
  .option(
    '--token-env <var>',
    'Env var holding a GitHub token for HTTPS clones',
    'GITHUB_TOKEN'
  )
  .option('--no-tui', 'Fail fast on missing/invalid input instead of launching the TUI')
  .option('--no-clone', 'Skip the eager git clone step (advanced)')
  .option(
    '--skills <slugs...>',
    'skillzkit catalog items to install after procurement (e.g. core:tools:npm)'
  )
  .option(
    '--skillzkit-bin <command>',
    'Override the skillzkit invocation (default: "npx -y @ecruz165/skillzkit")'
  )
  .parse();

const opts = program.opts<{
  name?: string;
  repos?: string[];
  dest?: string;
  tokenEnv?: string;
  tui: boolean;
  clone: boolean;
  skills?: string[];
  skillzkitBin?: string;
}>();

const positionalName = program.args[0];
const productName = opts.name ?? positionalName;

const { spec, missing, orgUrls } = specsFromCli(
  productName,
  opts.repos,
  opts.dest,
  opts.tokenEnv,
  !opts.clone,
  opts.skills,
  opts.skillzkitBin
);

let finalSpec: ProcureSpec | null = spec;

if (!finalSpec) {
  if (!opts.tui) {
    console.error(
      `error: missing or invalid args` +
        (missing.length ? ` (missing: ${missing.join(', ')})` : '') +
        (orgUrls.length
          ? `\n  org URLs detected (need full repo URLs): ${orgUrls.join(', ')}`
          : '')
    );
    process.exit(2);
  }

  finalSpec = await runTui({
    name: productName,
    repos: opts.repos,
    ...(opts.dest ? { dest: opts.dest } : {}),
    tokenEnv: opts.tokenEnv,
    noClone: !opts.clone,
  });

  if (!finalSpec) {
    console.error('aborted');
    process.exit(1);
  }
}

console.log(`Procuring "${finalSpec.name}" → ${finalSpec.dest}`);
console.log(`Repos:`);
for (const r of finalSpec.repos) {
  console.log(`  - ${r.name}  (${r.cloneUrl})`);
}
console.log();

const result = await procure(finalSpec);

if (!result.ok) {
  console.error(`✗ Procurement failed.`);
  for (const r of result.repos) {
    if (!r.cloned && r.reason) {
      console.error(`  ✗ ${r.repo.name}: ${r.reason.split('\n')[0]}`);
    }
  }
  process.exit(1);
}

console.log(`✓ Procurement complete.`);
console.log(`  Project:        ${result.projectDir}`);
console.log(`  VS Code:        code ${result.workspaceFile}`);
console.log(`  Config:         ${result.configFile}`);
for (const r of result.repos) {
  if (r.cloned && r.head) {
    console.log(`  Cloned ${r.repo.name} @ ${r.head.slice(0, 8)}`);
  }
}

if (result.skillsInstalled) {
  const s = result.skillsInstalled;
  if (s.exitCode === 0) {
    console.log(`  Skills:         ✓ installed via skillzkit (${s.requested.length} requested)`);
  } else {
    console.log(`  Skills:         ✗ skillzkit install failed (exit ${s.exitCode})`);
    if (s.output) {
      const tail = s.output.split('\n').slice(-6).join('\n');
      console.log(`    └─ output (last 6 lines):`);
      for (const line of tail.split('\n')) console.log(`       ${line}`);
    }
    const binHint = spec?.skillzkitBin ?? 'npx -y @ecruz165/skillzkit';
    console.log(`    re-run manually: ${binHint} install ${s.requested.join(' ')} --target ${result.projectDir}`);
  }
}

console.log();
console.log(`Next: cd ${finalSpec.name} && pnpm dev:servers`);
