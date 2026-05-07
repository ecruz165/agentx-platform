import { startHarnessServer } from './index.ts';

const socketPath = process.env.HARNESS_SOCKET_PATH ?? '/root/.harness/run/harness.sock';

console.log(`Starting @ecruz165/harness-server on ${socketPath}…`);
const handle = await startHarnessServer({ socketPath });
console.log(`✓ harness-server listening on ${socketPath}`);

const shutdown = async (signal: string) => {
  console.log(`Received ${signal}, stopping harness-server…`);
  await handle.stop();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGHUP', () => shutdown('SIGHUP'));

await new Promise(() => {});
