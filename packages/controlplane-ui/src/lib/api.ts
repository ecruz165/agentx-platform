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

/**
 * Structured API error. Subclasses standard Error so callers can do
 * `instanceof ApiError` to branch on parsed fields. For non-2xx
 * responses with a JSON body, populates `code` + `details` from the
 * envelope; for plain-text errors, the body lands in `message` only.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...headers, ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text();
    // Try to parse as a structured error envelope. Skillzkit's API
    // returns { code, message, details? } on every non-2xx; the
    // controlplane proxy preserves that shape on validation
    // failures + author/version conflicts.
    let envelope: { code?: string; message?: string; details?: Record<string, unknown> } | null = null;
    try {
      envelope = JSON.parse(text);
    } catch {
      // not JSON — fall through to plain text
    }
    throw new ApiError(
      res.status,
      envelope?.message ?? `${res.status} ${res.statusText}: ${text}`,
      envelope?.code,
      envelope?.details,
    );
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
  /** Number of jobs with both estimated and actual story points. */
  estimated: number;
  /** Mean of |actual - estimated| over the {@link estimated} cohort. */
  meanAbsError?: number | null;
  /** Mean of (actual - estimated). Positive = under-estimating. */
  bias?: number | null;
}

export const benchmarks = {
  compare: (runIds: string[]) =>
    request<BenchmarkRunSummary[]>(
      `/api/benchmarks/compare?runIds=${encodeURIComponent(runIds.join(","))}`,
    ),
};

// ── Skill proposals ──────────────────────────────────────────────────

export type ProposalStatus = "proposed" | "approved" | "rejected";

/** Mirrors skillzkit's ContributionStatus union plus a local-only
 *  'failed' for transport / 5xx errors. Null = never submitted (e.g.,
 *  approved before skillzkit was wired). */
export type RemoteStatus =
  | "pending"
  | "reviewing"
  | "accepted"
  | "rejected"
  | "promoted"
  | "failed";

export interface SkillProposal {
  id: string;
  sourceJobId?: string;
  name: string;
  description?: string;
  rationale?: string;
  category?: string;
  tags: string[];
  status: ProposalStatus;
  reviewer?: string;
  reviewedAt?: string;
  rejectionReason?: string;
  catalogItemId?: string;
  createdAt: string;
  /** Skillzkit upstream tracking. Null when skillzkit isn't configured
   *  or the proposal was approved before skillzkit was wired. */
  remoteId?: string;
  remoteStatus?: RemoteStatus;
  remoteUrl?: string;
  remoteError?: string;
  remoteSyncedAt?: string;
}

export const skillProposals = {
  list: (status?: ProposalStatus) =>
    request<SkillProposal[]>(
      `/api/skill-proposals${status ? `?status=${status}` : ""}`,
    ),
  approve: (id: string) =>
    request<SkillProposal>(`/api/skill-proposals/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  reject: (id: string, reason: string) =>
    request<SkillProposal>(`/api/skill-proposals/${id}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  resubmit: (id: string) =>
    request<SkillProposal>(`/api/skill-proposals/${id}/resubmit`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
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

// ── Compose (author-from-scratch contribution) ──────────────────────
//
// Bypasses the proposal flow: a user authors a new skillzkit artifact
// directly in the controlplane UI and submits it through the
// controlplane proxy to skillzkit's POST /api/v1/contributions.
//
// Backend contract (Spring controlplane endpoint - to be added):
//
//   POST /api/skill-proposals/compose
//     Body: ComposeRequest
//     Response 201: ComposeResponse - submission accepted by skillzkit
//     Response 422: { code: "validation_failed", message,
//                     details: { findings: ReviewFinding[] } }
//                   - skillzkit's layer-1/2/3 validation rejected the
//                     bundle. Findings explain what to fix.
//     Response 403: { code: "author_mismatch",
//                     details: { ownerAuthorId } }
//                   - the slug is owned by a different author already.
//     Response 409: { code: "slug_conflict", details: { version } }
//                   - this exact (slug, version) was already published.
//                     Bump the version.
//
//   The controlplane proxy fetches the user's skillzkit API key
//   (associated with their controlplane identity), decrypts it
//   server-side, and forwards the call to skillzkit. UI never sees
//   the plaintext API key.

/**
 * One file in a contribution bundle. Commands and workflows submit a
 * single-element array; skills submit SKILL.md plus optional companion
 * files (.py / .sh / .ts / .js / .json / .yaml / .toml).
 */
export interface ContributionFile {
  /** Relative path within the bundle - no leading slash, no `..`. */
  path: string;
  /** UTF-8 text content. */
  content: string;
}

export type ContributionKind = "command" | "workflow" | "skill";

/**
 * A single validation finding from skillzkit's three-layer pipeline
 * (structural / file-bundle / agent-review). Severity drives the
 * block decision (high blocks; medium/low surface but allow).
 */
export interface ReviewFinding {
  severity: "low" | "medium" | "high";
  axis: "structural" | "bundle" | "quality" | "tag-fit" | "safety";
  message: string;
  /** File within the bundle the finding applies to, when scoped. */
  fileRef?: string;
}

export interface ComposeRequest {
  kind: ContributionKind;
  /** Slash-command slug (commands/workflows) or skill name. */
  slug: string;
  /** Frontmatter parsed from the primary file - keys depend on kind. */
  frontmatter: Record<string, unknown>;
  files: ContributionFile[];
  versionBump?: "major" | "minor" | "patch";
  changelog?: string;
}

export interface AuthorIdentity {
  id: string;
  displayName: string;
  email?: string;
}

export type ContributionStatus =
  | "pending"
  | "reviewing"
  | "accepted"
  | "rejected"
  | "promoted";

export interface ComposeResponse {
  /** Content-addressable id: "<kind>:<slug>@<version>". */
  id: string;
  slug: string;
  kind: ContributionKind;
  status: ContributionStatus;
  /** Set when the contribution lands in storage. */
  version?: string;
  /** Whether the catalog index points at this version. New
   *  submissions are stored but NOT promoted - a maintainer or the
   *  author promotes explicitly. */
  promoted: boolean;
  author: AuthorIdentity;
  findings: ReviewFinding[];
  createdAt: string;
}

export const compose = {
  /**
   * Submit a new contribution. Throws ApiError with `code` set on
   * non-2xx responses; callers should branch on `code` to render the
   * right remediation (validation findings vs author mismatch vs
   * slug conflict).
   */
  submit: (req: ComposeRequest) =>
    request<ComposeResponse>("/api/skill-proposals/compose", {
      method: "POST",
      body: JSON.stringify(req),
    }),
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
