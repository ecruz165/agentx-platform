#!/usr/bin/env bun
/**
 * `workspace` — control-plane lifecycle CLI for the agentx platform.
 *
 * Subcommands:
 *   workspace setup <name>    procure a new project (clone repos + scaffold)
 *   workspace start           boot infra + controlplane + 3 peer servers
 *   workspace web             open the browser to the UI (default :5173)
 *
 * Setup is one-time scaffolding; start is the daily lifecycle entry point;
 * web just launches a browser. Each is a no-op against the others — the
 * user composes them as the situation requires.
 */

import { Command } from 'commander';
import { runSetup } from './setup.ts';
import { runStart } from './start.ts';
import { runWeb } from './web.ts';

const program = new Command()
  .name('workspace')
  .description('agentx — workspace + platform lifecycle CLI')
  .showHelpAfterError();

program
  .command('setup [name]')
  .description('procure a new agentx project from workspace-template/')
  .option('--name <name>', 'product name (doubles as workspace dir + product id)')
  .option('--repos <urls...>', 'repository clone URLs (HTTPS or SSH)')
  .option('--dest <dir>', 'destination directory (default: ./workspace-<name>)')
  .option('--token-env <var>', 'env var holding a GitHub token for HTTPS clones', 'GITHUB_TOKEN')
  .option('--no-tui', 'fail fast on missing/invalid input instead of launching the TUI')
  .option('--no-clone', 'skip the eager git clone step (advanced)')
  .option('--skills <slugs...>', 'skillzkit catalog items to install (e.g. core:tools:npm)')
  .option('--skillzkit-bin <command>', 'override the skillzkit invocation', 'npx -y @ecruz165/skillzkit')
  .action(async (positionalName: string | undefined, opts) => {
    await runSetup({
      ...opts,
      positionalName,
    });
  });

program
  .command('start')
  .description('boot infra + controlplane + harness/context/memory peer servers')
  .option('--skip-infra', 'skip docker-compose (assume Postgres/Neo4j/embedder already up)')
  .option('--skip-controlplane', 'skip the Spring controlplane (run it manually for debug)')
  .option('--skip-servers', 'skip the TS peer servers (harness/context/memory)')
  .option('--platform-root <dir>', 'override the agentx-platform repo root (env: AGENTX_PLATFORM_ROOT)')
  .action(async (opts) => {
    await runStart(opts);
  });

program
  .command('web')
  .description('open the browser to the control-plane UI')
  .option('--url <url>', 'UI URL (default: http://localhost:5173)')
  .option('--no-open', 'print the URL instead of opening the browser')
  .action(async (opts) => {
    await runWeb(opts);
  });

await program.parseAsync();
