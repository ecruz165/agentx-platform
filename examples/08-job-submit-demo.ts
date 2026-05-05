import { spawn } from 'node:child_process';
import { startHarnessServer } from '@agentx/harness-server';
import { join } from 'node:path';

/**
 * Job-submit demo: proves the registered-yaml + CLI submit chain.
 *
 *   harness-workspace.yml ──► CLI validates productId ──► harness submit
 *      (registered)              (decision #4)              POSTs /v1/jobs
 *                                                                ▼
 *                                                           harness-server
 *                                                           (echo for MVP-1)
 */
const SOCKET_DIR = join(process.cwd(), '.harness', 'run');
const harnessSocket = join(SOCKET_DIR, 'harness.sock');

const harnessSrv = await startHarnessServer({ socketPath: harnessSocket });
console.log('harness-server (echo) up at', harnessSocket, '\n');

try {
  console.log('▶ List registered products from harness-workspace.yml\n');
  await runCli(['project', 'list']);

  console.log('\n▶ Show one product\n');
  await runCli(['project', 'show', 'skoolscout-com']);

  console.log('\n▶ Submit a job against the agentx-dev product (using --input-text)\n');
  await runCli([
    'submit',
    'feature-add',
    '--product',
    'agentx-dev',
    '--input-text',
    'Add a redactCapture() implementation to packages/agent-adapter/src/capture.ts',
  ]);

  console.log('\n▶ Submit two real skoolscout-com jobs (using session.productId fallback)\n');
  await runCli(['session', 'set', 'productId', 'skoolscout-com']);
  await runCli([
    'submit',
    'feature-add',
    '--name',
    'Office Hours',
    '--input-text',
    'Implement an Office Hours feature on skoolscout.com — scheduling UI on web + booking endpoints on jefelabs.com.',
  ]);
  await runCli([
    'submit',
    'feature-add',
    '--name',
    'Programs & Events',
    '--input-text',
    'Implement Programs & Events listings + RSVP flow across skoolscout-com (frontend) and jefelabs-com (backend).',
  ]);

  console.log('\n▶ Submission against unknown product (expected to fail)\n');
  try {
    await runCli([
      'submit',
      'feature-add',
      '--product',
      'no-such-product',
      '--input-text',
      'should not reach the server',
    ]);
    console.error('  ✗ expected failure but submit succeeded');
    process.exitCode = 1;
  } catch {
    console.log('  ✓ submit refused (yaml validation caught unknown product)');
  }

  console.log('\n✓ Job-submit chain verified end-to-end');
} finally {
  await harnessSrv.stop();
}

function runCli(args: string[]): Promise<void> {
  console.log(`  $ harness ${args.join(' ')}`);
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
      const indented = out
        .split('\n')
        .map((l) => (l ? `    ${l}` : l))
        .join('\n');
      process.stdout.write(indented);
      if (code !== 0) reject(new Error(`harness ${args.join(' ')} exited ${code}`));
      else resolve();
    });
  });
}
