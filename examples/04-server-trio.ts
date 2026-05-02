import { join } from 'node:path';
import { startHarnessServer } from '@agentx/harness-server';
import { startMemoryServer } from '@agentx/edge-memory-server';
import { startContextServer } from '@agentx/edge-context-server';

const SOCKET_DIR = join(process.cwd(), '.harness', 'run');
const harnessSocket = join(SOCKET_DIR, 'harness.sock');
const memorySocket = join(SOCKET_DIR, 'memory.sock');
const contextSocket = join(SOCKET_DIR, 'context.sock');

const harnessSrv = await startHarnessServer({ socketPath: harnessSocket });
const memorySrv = await startMemoryServer({ socketPath: memorySocket });
const contextSrv = await startContextServer({ socketPath: contextSocket });

console.log('All three peer servers started (echo stubs):');
console.log(`  harness  → ${harnessSocket}`);
console.log(`  memory   → ${memorySocket}`);
console.log(`  context  → ${contextSocket}`);
console.log('');
console.log('In another terminal, try:');
console.log('  pnpm harness server status');
console.log('  pnpm harness auth login github-copilot');
console.log('  pnpm harness auth status');
console.log('  pnpm dev:propagation-demo');
console.log('');
console.log('Press Ctrl+C to stop.');

const shutdown = async (signal: string) => {
  console.log(`\nReceived ${signal}, stopping servers…`);
  await Promise.all([harnessSrv.stop(), memorySrv.stop(), contextSrv.stop()]);
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

await new Promise(() => {});
