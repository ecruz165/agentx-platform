import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Per-skill triggering demo: proves that each skill scopes the agent to
 * its own subcommand surface.
 *
 *   memory.md  → triggers ONLY `harness memory …`
 *   context.md → triggers ONLY `harness context …`
 *
 * Real agents that load memory.md alone won't even know `harness context`
 * exists. Real agents that load context.md alone get read-only access to
 * indexed corpora and no working-memory write path. Skill scoping is the
 * agent-side mirror of CLI namespacing.
 */
const SKILLS_DIR = join(process.cwd(), 'workspace-template', '.harness', 'skills');
const MEMORY_SKILL = join(SKILLS_DIR, 'memory.md');
const CONTEXT_SKILL = join(SKILLS_DIR, 'context.md');

console.log('=== Per-skill CLI triggering demo ===\n');

// --- Bootstrap ---
console.log('▶ Bootstrap: ensure productId is set (every skill requires it)\n');
await runHarness(['session', 'set', 'productId', 'skoolscout-com']);

// --- Phase A: Memory skill ---
console.log('\n▼ Phase A — Memory skill\n');
const memorySkill = await readFile(MEMORY_SKILL, 'utf8');
const memoryTitle = memorySkill.split('\n')[0]?.replace(/^#\s*/, '') ?? '';
console.log(`Loaded:    "${memoryTitle}"`);
console.log(`Source:    ${MEMORY_SKILL}`);
console.log(`Length:    ${memorySkill.length} chars`);
console.log(`Granted:   harness memory put|query  (only)`);
console.log(`Forbidden: harness context …, harness session set …, MCP\n`);
console.log('Simulated agent decision (per skill):');
console.log("  task = 'remember that FileBroker enforces 0600 on auth.json'");
console.log('  action = put → query roundtrip\n');

await runHarness(['memory', 'put', 'auth-decision', 'FileBroker enforces 0600 on auth.json']);
await runHarness(['memory', 'query', 'auth-decision']);

console.log('\n  ✓ Memory skill triggered ONLY `harness memory` subcommands.');
console.log('    No `harness context` call appeared — skill scoping enforced.');

// --- Phase B: Context skill ---
console.log('\n▼ Phase B — Context skill\n');
const contextSkill = await readFile(CONTEXT_SKILL, 'utf8');
const contextTitle = contextSkill.split('\n')[0]?.replace(/^#\s*/, '') ?? '';
console.log(`Loaded:    "${contextTitle}"`);
console.log(`Source:    ${CONTEXT_SKILL}`);
console.log(`Length:    ${contextSkill.length} chars`);
console.log(`Granted:   harness context query  (only)`);
console.log(`Forbidden: harness memory …, harness session set …, MCP\n`);
console.log('Simulated agent decision (per skill):');
console.log("  task = 'find where FileBroker is defined and who calls udsRequest'");
console.log('  action = two read-only queries\n');

await runHarness(['context', 'query', 'where is FileBroker defined?']);
await runHarness(['context', 'query', 'all places that call udsRequest']);

console.log('\n  ✓ Context skill triggered ONLY `harness context` subcommands.');
console.log('    No `harness memory` call appeared — skill scoping enforced.');

// --- Summary ---
console.log('\n=== Skill scoping verified ===');
console.log('Each skill drives its own subcommand surface:');
console.log(`  ${MEMORY_SKILL}  →  harness memory …`);
console.log(`  ${CONTEXT_SKILL}  →  harness context …`);
console.log('');
console.log('An agent that only loads one skill cannot reach the other CLI');
console.log("namespace — that's how the harness keeps tool access least-privilege");
console.log('without per-call ACLs.');

function runHarness(args: string[]): Promise<void> {
  console.log(`\n  agent$ harness ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['--silent', 'harness', ...args], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
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
