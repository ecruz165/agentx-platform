import { startContextServer } from './index.ts';

const socketPath = process.env.CONTEXT_SOCKET_PATH ?? '/root/.harness/run/context.sock';

console.log(`Starting @ecruz165/edge-context-server on ${socketPath}…`);
const handle = await startContextServer({ socketPath });
console.log(`✓ edge-context-server listening on ${socketPath}`);

const shutdown = async (signal: string) => {
  console.log(`Received ${signal}, stopping edge-context-server…`);
  await handle.stop();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGHUP', () => shutdown('SIGHUP'));

await new Promise(() => {});
