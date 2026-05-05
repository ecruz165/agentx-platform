import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { startMemoryServer } from '@agentx/edge-memory-server';
import { startContextServer } from '@agentx/edge-context-server';

const SOCKET_DIR = join(process.cwd(), '.harness', 'run');
const memorySocket = join(SOCKET_DIR, 'memory.sock');
const contextSocket = join(SOCKET_DIR, 'context.sock');

const memorySrv = await startMemoryServer({ socketPath: memorySocket });
const contextSrv = await startContextServer({ socketPath: contextSocket });

console.log('Echo servers started:');
console.log(`  memory  → ${memorySocket}`);
console.log(`  context → ${contextSocket}\n`);

let failures = 0;

try {
  await expectCli(['session', 'set', 'productId', 'skoolscout-com'], (out) =>
    out.includes('session.productId = skoolscout-com')
  );

  await expectCli(['memory', 'put', 'recent-edit', 'fixed null bug in auth.ts'], (out) =>
    out.includes('"service": "memory"') && out.includes('skoolscout-com')
  );

  await expectCli(['memory', 'query', 'recent-edit'], (out) =>
    out.includes('"service": "memory"') && out.includes('recent-edit')
  );

  await expectCli(['context', 'query', 'where is the auth broker defined?'], (out) =>
    out.includes('"service": "context"') && out.includes('auth broker')
  );

  if (failures === 0) {
    console.log('\n✓ All CLI → UDS → echo roundtrips succeeded');
  } else {
    console.error(`\n✗ ${failures} roundtrip(s) failed`);
    process.exitCode = 1;
  }
} finally {
  await memorySrv.stop();
  await contextSrv.stop();
}

async function expectCli(args: string[], check: (stdout: string) => boolean): Promise<void> {
  console.log(`$ harness ${args.join(' ')}`);
  const out = await runCli(args);
  process.stdout.write(out);
  if (!check(out)) {
    console.error(`  ✗ assertion failed for: harness ${args.join(' ')}`);
    failures++;
  }
}

function runCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'pnpm',
      ['--silent', 'harness', ...args],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    );
    let out = '';
    child.stdout.on('data', (c) => (out += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`harness ${args.join(' ')} exited ${code}`));
      else resolve(out);
    });
  });
}
