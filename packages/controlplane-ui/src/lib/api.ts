// Hand-written fetcher layer. Phase 6 v1 skips OpenAPI codegen — the
// surface is small and codegen adds tooling weight. When the backend
// API stabilizes, swap these for generated types from /v3/api-docs.

const ORG_ID = "dev-org"; // Phase 7 will replace with OIDC-derived tenant
const USER_ID = "dev-user";

const headers: HeadersInit = {
  "Content-Type": "application/json",
  "X-Org-Id": ORG_ID,
  "X-User-Id": USER_ID,
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...headers, ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ── Intent ────────────────────────────────────────────────────────────

export interface IntentSession {
  id: string;
  userId: string;
  intakePipelineId: string;
  intakeJobId?: string;
  workJobId?: string;
  status:
    | "awaiting-message"
    | "processing"
    | "intent-ready"
    | "pipeline-creation-required"
    | "submitted"
    | "expired"
    | "aborted"
    | "failed";
  resolvedIntent?: unknown;
  failureReason?: string;
  createdAt: string;
  lastActivityAt: string;
}

export const intent = {
  start: (body: { intakePipelineId?: string; productId?: string; initialInput?: unknown }) =>
    request<IntentSession>("/api/intent/sessions", { method: "POST", body: JSON.stringify(body) }),
  list: () => request<IntentSession[]>("/api/intent/sessions"),
  get: (id: string) => request<IntentSession>(`/api/intent/sessions/${id}`),
  abort: (id: string) =>
    request<IntentSession>(`/api/intent/sessions/${id}/abort`, { method: "POST" }),
  message: (id: string, message: string) =>
    request<IntentSession>(`/api/intent/sessions/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
  confirm: (id: string, intent: { flowId: string; productId: string; input?: unknown }) =>
    request<IntentSession>(`/api/intent/sessions/${id}/confirm`, {
      method: "POST",
      body: JSON.stringify(intent),
    }),
};

// ── Jobs ──────────────────────────────────────────────────────────────

export interface Job {
  id: string;
  flowId: string;
  productId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  input?: unknown;
  output?: unknown;
  failureReason?: string;
  currentNodeId?: string;
  benchmarkRunId?: string;
  benchmarkLabel?: string;
  evalScore?: number | null;
  evalRationale?: string;
  evalJudge?: string;
  evalScoredAt?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export const jobs = {
  list: () => request<Job[]>("/api/jobs"),
  listByBenchmarkRun: (runId: string, limit = 500) =>
    request<Job[]>(
      `/api/jobs?benchmarkRunId=${encodeURIComponent(runId)}&limit=${limit}`,
    ),
  get: (id: string) => request<Job>(`/api/jobs/${id}`),
  start: (id: string) => request<Job>(`/api/jobs/${id}/start`, { method: "POST" }),
  cancel: (id: string) => request<Job>(`/api/jobs/${id}/cancel`, { method: "POST" }),
};

// ── Benchmarks ────────────────────────────────────────────────────────

export interface BenchmarkRunSummary {
  runId: string;
  label?: string;
  total: number;
  completed: number;
  failed: number;
  inFlight: number;
  cancelled: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  successRate: number;
  scored: number;
  avgScore?: number | null;
  p50Score?: number | null;
}

export const benchmarks = {
  compare: (runIds: string[]) =>
    request<BenchmarkRunSummary[]>(
      `/api/benchmarks/compare?runIds=${encodeURIComponent(runIds.join(","))}`,
    ),
};

// ── Catalog ───────────────────────────────────────────────────────────

export interface Flow {
  id: string;
  description?: string;
  kind: "work" | "job-definition" | "post-job";
  output?: unknown;
  nodes: unknown;
  edges: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface Product {
  id: string;
  displayName?: string;
  repos?: unknown[];
  createdAt: string;
  updatedAt: string;
}

export const catalog = {
  flows: () => request<Flow[]>("/api/catalog/flows"),
  flow: (id: string) => request<Flow>(`/api/catalog/flows/${id}`),
  products: () => request<Product[]>("/api/catalog/products"),
};

// ── SSE helper ────────────────────────────────────────────────────────

/**
 * Subscribe to an Intent session's SSE stream. Returns a cleanup function.
 * Browser EventSource doesn't support custom headers, so the X-Org-Id
 * header is injected via the proxy in dev (vite.config.ts) — and at
 * Phase 7, OIDC cookies replace header auth entirely.
 */
export function subscribeToSession(
  sessionId: string,
  handlers: {
    onIntentReady?: (data: { sessionId: string; resolvedIntent: unknown }) => void;
    onJobSubmitted?: (data: { sessionId: string; workJobId: string }) => void;
    onAborted?: (data: { sessionId: string }) => void;
    onPipelineCreationRequired?: (data: { sessionId: string; pipelineSpec: unknown }) => void;
    onError?: (data: { sessionId: string; message: string }) => void;
    onAny?: (kind: string, data: unknown) => void;
  },
): () => void {
  const url = `/api/intent/sessions/${sessionId}/events`;
  const es = new EventSource(url);

  const wire = (kind: string, h?: (d: unknown) => void) => {
    es.addEventListener(kind, (ev) => {
      const data = JSON.parse((ev as MessageEvent).data);
      handlers.onAny?.(kind, data);
      h?.(data);
    });
  };

  wire("intent-ready", handlers.onIntentReady as (d: unknown) => void);
  wire("job-submitted", handlers.onJobSubmitted as (d: unknown) => void);
  wire("aborted", handlers.onAborted as (d: unknown) => void);
  wire("pipeline-creation-required", handlers.onPipelineCreationRequired as (d: unknown) => void);
  wire("error", handlers.onError as (d: unknown) => void);
  wire("session-started", undefined);
  wire("pipeline-created", undefined);

  return () => es.close();
}
