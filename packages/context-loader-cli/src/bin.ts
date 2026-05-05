#!/usr/bin/env bun
/**
 * agentx-load — CLI for the context loader.
 *
 * Phase A: skeleton — recognizes the documented subcommands and prints
 * an explanatory "not yet implemented" message + pointer to PRD phases.
 * Phase F (per .plans/2026-05-05-prd-context-loader-cli.md §13) wires the
 * real subcommands once core's Phase B+C land.
 *
 * Standalone vs job mode (Phase G):
 *   Standalone — runs in-process, writes to backend, no triad needed.
 *   Job mode   — invoked as a worker container's entrypoint; emits
 *                IngestionEvent JSON over the UDS named by
 *                --output-events-uds=<path>; harness-server's spawnWorker
 *                bridges to JobBus.
 */

import { BUILTIN_SOURCE_TYPE_IDS } from '@agentx/context-loader-core';

const KNOWN_SUBCOMMANDS = new Set([
  'add',
  'list',
  'describe',
  'refresh',
  'remove',
  'crawl',
  'upload',
  'oss',
  'types',
  'stats',
  'dry-run',
]);

function printUsage(): void {
  process.stdout.write(
    `agentx-load — load context sources into a graph backend.\n` +
      `\n` +
      `Usage:\n` +
      `  agentx-load <subcommand> [args]\n` +
      `\n` +
      `Subcommands (Phase F+):\n` +
      `  add <target>             Register and ingest a context source\n` +
      `  list                     Show registered sources\n` +
      `  describe <source-id>     Show details for a source\n` +
      `  refresh <source-id>      Re-ingest a source incrementally\n` +
      `  remove <source-id>       Drop a source's nodes/edges/vectors\n` +
      `  crawl <url>              Run the crawled-web source type\n` +
      `  upload <file>            Single-file upload (PDF, image, etc.)\n` +
      `  oss <verb>               OSS dependency convenience namespace\n` +
      `  types                    List source types in the built-in catalog\n` +
      `  stats                    Counts: nodes/edges/vectors\n` +
      `  dry-run <target>         Show what would be ingested, no writes\n` +
      `\n` +
      `For now (Phase A):\n` +
      `  agentx-load types        Lists the v1 catalog ids (works today)\n` +
      `  agentx-load --version    Prints the package version (works today)\n` +
      `  Other subcommands print a "not yet implemented" message.\n` +
      `\n` +
      `See:\n` +
      `  .plans/2026-05-05-prd-context-loader-core.md\n` +
      `  .plans/2026-05-05-prd-context-loader-cli.md\n`
  );
}

function printTypes(): void {
  process.stdout.write(`Built-in source types (Phase A — matcher + schema declared, chunkers in Phase B+):\n\n`);
  for (const id of BUILTIN_SOURCE_TYPE_IDS) {
    process.stdout.write(`  - ${id}\n`);
  }
  process.stdout.write(
    `\n` +
      `Run \`agentx-load types describe <id>\` (Phase F) for per-type details.\n` +
      `Built-in catalog source: packages/context-loader-core/src/catalog/index.ts\n`
  );
}

function printVersion(): void {
  // Phase A: hardcoded; Phase F reads from package.json.
  process.stdout.write(`agentx-load 0.0.0 (Phase A skeleton)\n`);
}

function notYetImplemented(subcommand: string): void {
  process.stderr.write(
    `agentx-load: subcommand '${subcommand}' is not yet implemented.\n` +
      `\n` +
      `Phase A ships the package skeleton + types + catalog only. The real\n` +
      `subcommands land in Phase F (CLI wiring) once core's Phase B+C complete.\n` +
      `\n` +
      `See .plans/2026-05-05-prd-context-loader-cli.md §13 for the implementation timeline.\n`
  );
  process.exit(1);
}

const [first, ...rest] = process.argv.slice(2);

if (!first || first === '--help' || first === '-h') {
  printUsage();
  process.exit(0);
}

if (first === '--version' || first === '-v') {
  printVersion();
  process.exit(0);
}

if (first === 'types' && rest.length === 0) {
  printTypes();
  process.exit(0);
}

if (KNOWN_SUBCOMMANDS.has(first)) {
  notYetImplemented(first);
}

// Unknown subcommand
process.stderr.write(`agentx-load: unknown subcommand '${first}'.\n\n`);
printUsage();
process.exit(2);
