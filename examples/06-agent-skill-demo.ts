import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Scripted agent simulation: proves the SKILL.md → harness CLI → UDS chain.
 *
 * Real LLM-driven agents (Claude SDK with tool_use, OpenCode CLI, future
 * Copilot adapter) will follow the same path — they read the SKILL.md as
 * part of their system prompt, then their Bash tool spawns these exact
 * commands. By exercising the path here without an LLM, we prove the
 * downstream contract holds before integrating a real model.
 */
const SKILL_PATH = join(
  process.cwd(),
  'workspace-template',
  '.harness',
  'skills',
  'harness-cli.md'
);

console.log('=== Scripted agent — SKILL.md → harness CLI demo ===\n');

const skill = await readFile(SKILL_PATH, 'utf8');
const skillTitle = skill.split('\n')[0]?.replace(/^#\s*/, '') ?? '(no title)';
console.log(`Loaded SKILL: "${skillTitle}"`);
console.log(`Source: ${SKILL_PATH}`);
console.log(`Length: ${skill.length} chars\n`);

console.log('A real agent would ingest this SKILL.md as system context, then');
console.log("plan + execute. Here we simulate that plan directly:\n");
console.log('  1. ensure productId is set (per SKILL.md "Required precondition")');
console.log('  2. write a memory entry about a refactor decision');
console.log('  3. read it back');
console.log('  4. query context for a related question');

await runHarness(['session', 'set', 'productId', 'skoolscout-com']);
await runHarness(['memory', 'put', 'auth-decision', 'broker reads ~/.agentx/auth.json mode 0600']);
await runHarness(['memory', 'query', 'auth-decision']);
await runHarness(['context', 'query', 'where is FileBroker defined?']);

console.log('\n✓ Agent skill flow verified end-to-end:');
console.log('  SKILL.md → simulated agent decision → harness CLI subprocess');
console.log('  → UDS → echo server → JSON response → agent\n');
console.log('Decisions enforced along the way:');
console.log('  #2  No MCP at any point — only the harness CLI talks to peer servers');
console.log('  #4  productId threaded into every memory/context request body');
console.log('  #5  UDS sockets at mode 0600 — udsRequest verifies before connecting');

function runHarness(args: string[]): Promise<void> {
  console.log(`\n  agent$ harness ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    const child = spawn(
      'pnpm',
      ['--silent', '--filter', '@agentx/harness-cli', 'exec', 'tsx', 'src/index.ts', ...args],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    );
    let out = '';
    child.stdout.on('data', (c) => (out += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      const indented = out
        .split('\n')
        .map((l) => (l ? `    ${l}` : l))
        .join('\n');
      process.stdout.write(indented);
      if (code !== 0) {
        reject(new Error(`harness ${args.join(' ')} exited ${code}`));
      } else {
        resolve();
      }
    });
  });
}
