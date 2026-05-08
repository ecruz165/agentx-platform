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
import {
  type Catalog,
  type FlowDef,
  type ProductDef,
  startHarnessServer,
} from '@ecruz165/harness-server';

const harnessSocket = process.env.HARNESS_SOCKET ?? '/run/harness/harness.sock';
mkdirSync(dirname(harnessSocket), { recursive: true });

// Clear stale socket from a prior crash so bind succeeds.
try {
  rmSync(harnessSocket);
} catch {
  /* not present, fine */
}

// Catalog source: HTTP fetch from controlplane. The harness loads once at
// startup; the controlplane is the source of truth. Future: re-fetch on
// a periodic schedule or via an SSE catalog-changed stream.
const controlplaneUrl = (process.env.CONTROLPLANE_URL ?? 'http://controlplane:8080').replace(
  /\/+$/,
  '',
);
const orgId = process.env.AGENTX_ORG_ID ?? 'dev-org';

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${controlplaneUrl}${path}`, {
    headers: { 'X-Org-Id': orgId, Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GET ${path} → ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

const loadCatalog = async (): Promise<Catalog> => {
  console.log(`[harness-server] loading catalog from ${controlplaneUrl} (orgId=${orgId})…`);
  // The controlplane's FlowDTO and ProductDTO shapes are JSON-compatible
  // with harness-core's FlowDef / ProductDef. We trust the wire format
  // here; a future iteration can add validation via zod.
  const [flows, products] = await Promise.all([
    fetchJson<FlowDef[]>('/api/catalog/flows'),
    fetchJson<ProductDef[]>('/api/catalog/products').catch((err) => {
      // Products are optional — log and proceed with []. Flows are
      // required (the harness can't dispatch without them).
      console.warn(`[harness-server] products fetch failed (proceeding without): ${err.message}`);
      return [] as ProductDef[];
    }),
  ]);
  console.log(`[harness-server] catalog loaded: ${flows.length} flow(s), ${products.length} product(s)`);
  return { flows, products };
};

const harnessSrv = await startHarnessServer({
  socketPath: harnessSocket,
  loadCatalog,
});

console.log(`[harness-server] listening on ${harnessSocket}`);
console.log(`[harness-server] edge sockets: ${process.env.EDGE_SOCKETS_DIR ?? '/run/edge'}`);
console.log('[harness-server] ready; SIGTERM to stop');

const shutdown = async () => {
  console.log('[harness-server] shutdown…');
  await harnessSrv.stop().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
