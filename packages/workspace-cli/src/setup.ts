/**
 * `workspace setup` — extracted from the original bin.tsx default flow.
 *
 * Procures a new project workspace from `workspace-template/`: clones repos,
 * writes the .code-workspace file, optionally installs skillzkit catalog
 * items. One-time scaffolding; daily lifecycle moves to `workspace start`.
 */

import { procure, specsFromCli } from './procure.ts';
import { runTui } from './tui.tsx';
import type { ProcureResult, ProcureSpec } from './types.ts';

export interface SetupOptions {
  name?: string;
  positionalName?: string;
  repos?: string[];
  dest?: string;
  tokenEnv?: string;
  tui?: boolean;
  clone?: boolean;
  skills?: string[];
  skillzkitBin?: string;
}

export async function runSetup(opts: SetupOptions): Promise<void> {
  const productName = opts.name ?? opts.positionalName;
  const tokenEnv = opts.tokenEnv ?? 'GITHUB_TOKEN';
  const tuiEnabled = opts.tui !== false;
  const cloneEnabled = opts.clone !== false;

  const { spec, missing, orgUrls } = specsFromCli(
    productName,
    opts.repos,
    opts.dest,
    tokenEnv,
    !cloneEnabled,
    opts.skills,
    opts.skillzkitBin,
  );

  let finalSpec: ProcureSpec | null = spec;

  if (!finalSpec) {
    if (!tuiEnabled) {
      console.error(
        `error: missing or invalid args` +
          (missing.length ? ` (missing: ${missing.join(', ')})` : '') +
          (orgUrls.length
            ? `\n  org URLs detected (need full repo URLs): ${orgUrls.join(', ')}`
            : ''),
      );
      process.exit(2);
    }

    finalSpec = await runTui({
      name: productName,
      repos: opts.repos,
      ...(opts.dest ? { dest: opts.dest } : {}),
      tokenEnv,
      noClone: !cloneEnabled,
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

  let result: ProcureResult;
  try {
    result = await procure(finalSpec);
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    process.exit(1);
  }

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
      const binHint = finalSpec?.skillzkitBin ?? 'npx -y @ecruz165/skillzkit';
      console.log(
        `    re-run manually: ${binHint} install ${s.requested.join(' ')} --target ${result.projectDir}`,
      );
    }
  }

  console.log();
  console.log(`Next: workspace start    # boot the platform (controlplane + harness/context/memory)`);
  console.log(`      workspace web      # open the browser UI`);
}
