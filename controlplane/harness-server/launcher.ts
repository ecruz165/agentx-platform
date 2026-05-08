/**
 * harness-server launcher — runs @ecruz165/harness-server inside the
 * harness-server container.
 *
 * The harness exposes a UDS at HARNESS_SOCKET (default /run/harness/harness.sock)
 * for incoming RPC. It also reaches edge-context + edge-memory via the
 * /run/edge/ shared volume mount (provisioned by the edge-server container).
 *
 * Catalog source: v1 inside docker has no workspace yaml file, so the
 * launcher returns an empty catalog. Flows are registered via the
 * controlplane's HTTP API; the harness picks them up at job-dispatch
 * time. A future iteration can fetch the catalog from
 * http://controlplane:8080/api/catalog/flows on startup.
 *
 * DooD: /var/run/docker.sock is bind-mounted in compose. The harness
 * uses this to spawn per-job pipeline-instance containers via the host
 * docker daemon. The DooD wiring is the harness's responsibility; this
 * launcher just makes the socket reachable.
 *
 * Configuration via env:
 *   HARNESS_SOCKET           — output UDS path (default /run/harness/harness.sock)
 *   EDGE_SOCKETS_DIR         — edge-context + edge-memory UDS dir (default /run/edge)
 *   AGENTX_EMBEDDER_URL      — passed through to harness-core if it needs query
 *   AGENTX_EMBEDDER_MODEL
 *   AGENTX_EMBEDDER_DIMENSION
 */

import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Catalog, startHarnessServer } from '@ecruz165/harness-server';

const harnessSocket = process.env.HARNESS_SOCKET ?? '/run/harness/harness.sock';
mkdirSync(dirname(harnessSocket), { recursive: true });

// Clear stale socket from a prior crash so bind succeeds.
try {
  rmSync(harnessSocket);
} catch {
  /* not present, fine */
}

// v1 catalog source: empty. Future: fetch from controlplane on startup.
const loadCatalog = async (): Promise<Catalog> => ({ flows: [] });

const harnessSrv = await startHarnessServer({
  socketPath: harnessSocket,
  loadCatalog,
});

console.log(`[harness-server] listening on ${harnessSocket}`);
console.log(`[harness-server] edge sockets: ${process.env.EDGE_SOCKETS_DIR ?? '/run/edge'}`);
console.log('[harness-server] ready; SIGTERM to stop');

const shutdown = async () => {
  console.log('[harness-server] shutdown…');
  await harnessSrv.close().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
