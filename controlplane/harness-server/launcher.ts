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
import { request as httpRequest } from 'node:http';
import { dirname } from 'node:path';
import {
  type Catalog,
  type FlowDef,
  type ProductDef,
  startHarnessServer,
} from '@ecruz165/harness-server';

interface DispatcherStatus {
  capacity: number;
  inFlight: string[];
  queued: Array<{ jobId: string; enqueuedAt: number; waitingMs: number }>;
}

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

// ── Self-register with controlplane's HarnessRegistry ────────────────
// POST /api/registry/harnesses; save sessionToken; loop heartbeats every
// HARNESS_HEARTBEAT_INTERVAL_MS (default 30 s). On shutdown we stop the
// heartbeat loop but don't deregister — the controlplane marks stale
// harnesses based on heartbeat timestamps. Phase 7 auth replaces the
// opaque sessionToken with a signed/scoped one; same RPC shape.
const harnessId = process.env.HARNESS_ID ?? `harness-${Bun.env.HOSTNAME ?? 'local'}`;
const harnessName = process.env.HARNESS_NAME ?? harnessId;
const harnessRegion = process.env.HARNESS_REGION ?? 'local';
const harnessVersion = process.env.HARNESS_VERSION ?? '0.1.0';
const heartbeatIntervalMs = Number(process.env.HARNESS_HEARTBEAT_INTERVAL_MS ?? 30000);
const registerEnabled = (process.env.HARNESS_REGISTER ?? 'true').toLowerCase() !== 'false';

let sessionToken: string | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

async function registerWithControlplane(): Promise<void> {
  const body = {
    id: harnessId,
    name: harnessName,
    version: harnessVersion,
    region: harnessRegion,
    capabilities: { adapters: ['claude-sdk'] },
    endpoints: { rpc: harnessSocket },
  };
  const res = await fetch(`${controlplaneUrl}/api/registry/harnesses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Org-Id': orgId,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`register failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { harnessId: string; sessionToken: string };
  sessionToken = data.sessionToken;
  console.log(`[harness-server] registered with controlplane: harnessId=${data.harnessId}`);
}

/**
 * Query the in-process harness-server for its dispatcher snapshot via
 * its UDS HTTP endpoint. Bun's fetch doesn't yet support unix sockets;
 * use node:http with socketPath. Returns null if the call fails (the
 * heartbeat continues without the snapshot in that case).
 */
function fetchDispatcherStatus(): Promise<DispatcherStatus | null> {
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        socketPath: harnessSocket,
        path: '/v1/dispatcher/status',
        method: 'GET',
        timeout: 2000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body) as DispatcherStatus & Record<string, unknown>;
            // The route adds `service` + `ts`; pick out the snapshot fields.
            resolve({
              capacity: parsed.capacity,
              inFlight: parsed.inFlight ?? [],
              queued: parsed.queued ?? [],
            });
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

async function sendHeartbeat(): Promise<void> {
  if (!sessionToken) return;
  const status = await fetchDispatcherStatus();
  const currentLoad = status?.inFlight.length ?? 0;

  try {
    const res = await fetch(`${controlplaneUrl}/api/registry/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Org-Id': orgId,
      },
      body: JSON.stringify({
        harnessId,
        sessionToken,
        currentLoad,
        healthOk: true,
        currentJobs: status,
      }),
    });
    if (!res.ok) {
      console.warn(`[harness-server] heartbeat ${res.status} — may need re-register`);
    }
  } catch (err) {
    console.warn(`[harness-server] heartbeat error: ${(err as Error).message}`);
  }
}

if (registerEnabled) {
  try {
    await registerWithControlplane();
    heartbeatTimer = setInterval(sendHeartbeat, heartbeatIntervalMs);
    console.log(`[harness-server] heartbeat loop every ${heartbeatIntervalMs}ms`);
  } catch (err) {
    console.warn(
      `[harness-server] register failed (continuing without registry): ${(err as Error).message}`,
    );
  }
} else {
  console.log('[harness-server] HARNESS_REGISTER=false — skipping controlplane registration');
}

console.log('[harness-server] ready; SIGTERM to stop');

const shutdown = async () => {
  console.log('[harness-server] shutdown…');
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  await harnessSrv.stop().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
