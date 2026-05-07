import { startMemoryServer } from './index.ts';

const socketPath = process.env.MEMORY_SOCKET_PATH ?? '/root/.harness/run/memory.sock';

console.log(`Starting @ecruz165/edge-memory-server on ${socketPath}…`);
const handle = await startMemoryServer({ socketPath });
console.log(`✓ edge-memory-server listening on ${socketPath}`);

const shutdown = async (signal: string) => {
  console.log(`Received ${signal}, stopping edge-memory-server…`);
  await handle.stop();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGHUP', () => shutdown('SIGHUP'));

await new Promise(() => {});
