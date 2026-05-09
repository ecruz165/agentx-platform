/**
 * `kind: 'tool'` step-kind executor.
 *
 * Resolves a TaskStep's `ToolConfig.toolId` through the supplied
 * `ToolResolver` to a `ToolDef`, then dispatches per kind:
 *
 *   - cli   → spawns via execFile; stdout → state.output
 *   - http  → fetch; response body (text or JSON-stringified) → state.output
 *   - mcp   → spawns or connects to MCP server; tool result → state.output
 *
 * All three paths normalize errors to the NodeExit shape so the flow's
 * error edge can catch them. A genuine throw from the executor is
 * reserved for *programming errors* (resolver missing, bad config) —
 * those should propagate up and fail the graph fast, not be silently
 * routed.
 *
 * Auth: every dispatch path that needs credentials calls into the
 * shared CredentialBroker on RunJobDeps. ToolDef.auth carries only a
 * reference (credentialId + scheme), never the secret itself — the
 * same separation we use for agent bindings.
 */
import { execFile } from 'node:child_process';
import type { CredentialBroker } from '@ecruz165/agent-auth';
import type {
  CliToolDef,
  Expression,
  HttpToolDef,
  McpToolDef,
  TaskStep,
  ToolAuthRef,
  ToolConfig,
  ToolDef,
  ToolResolver,
} from './catalog.ts';
import { evalExpression, type FlowStateT, type NodeExecutor } from './flow-graph.ts';

/** Default timeouts (ms). MCP gets longer because startup is real. */
const DEFAULT_CLI_TIMEOUT = 30_000;
const DEFAULT_HTTP_TIMEOUT = 30_000;
const DEFAULT_MCP_TIMEOUT = 60_000;
/** SIGTERM grace period before SIGKILL on a timed-out CLI. */
const SIGKILL_DELAY_MS = 5_000;

/** Optional dependencies the executor needs. Kept narrow so unit tests
 *  can drive the executor with mock fetch / mock spawn without pulling
 *  the full RunJobDeps shape. */
export interface ToolExecutorDeps {
  /** Required. The resolver typically wraps the catalog cache from
   *  controlplane. */
  toolResolver: ToolResolver;
  /** Required only for ToolDefs that declare `auth`. */
  broker?: CredentialBroker;
  /** Test seam: substitute fetch (e.g., mock-server). Defaults to
   *  globalThis.fetch. */
  fetchFn?: typeof fetch;
  /** Test seam: substitute MCP transport. Defaults to a stdio + sse
   *  shim that uses the @modelcontextprotocol/sdk client. Tests can
   *  inject a function that returns a static {ok|err} result without
   *  spawning a real MCP server. */
  mcpInvokeFn?: (def: McpToolDef, args: Record<string, unknown>) => Promise<McpResult>;
}

export type McpResult =
  | { ok: true; content: string }
  | { ok: false; errorName: string; errorMessage: string };

/**
 * Build the per-node executor for a `kind: 'tool'` TaskStep. Returns
 * the same NodeExecutor signature as the agent / gate / transform
 * executors — partial-state delta with `lastExit`.
 *
 * Throws (config error) when:
 *   - the supplied node isn't kind:'tool' (programming error)
 *   - the toolId resolves to a ToolDef whose `kind` we don't recognize
 *     (catalog drift; fail loud)
 *
 * Surfaces an error exit (routes via error edge) when:
 *   - toolId doesn't resolve (UnknownTool)
 *   - any dispatch path fails (UnknownExecutable, HttpError, McpError, …)
 *   - timeout is hit (Timeout)
 */
export function makeToolExecutor(node: TaskStep, deps: ToolExecutorDeps): NodeExecutor {
  if (node.kind !== 'tool') {
    throw new Error(`makeToolExecutor: node "${node.id}" has kind "${node.kind}", expected "tool"`);
  }
  const config = node.config as ToolConfig;
  const nodeId = node.id;
  const toolId = config.toolId;
  const stepArgs = config.args ?? {};

  return async (state) => {
    const def = deps.toolResolver(toolId);
    if (!def) {
      return errorExit(nodeId, 'UnknownTool', `no ToolDef registered for toolId "${toolId}"`);
    }

    // Resolve any Expression-typed step args against current state.
    // String/number/etc. literals pass through unchanged; jsonpath
    // entries get evaluated. The resulting plain map is what dispatch
    // sees.
    let resolvedArgs: Record<string, unknown>;
    try {
      resolvedArgs = resolveStepArgs(stepArgs, state);
    } catch (err) {
      return errorExit(nodeId, 'ArgResolutionError', (err as Error).message);
    }

    try {
      switch (def.kind) {
        case 'cli':
          return await dispatchCli(nodeId, def, resolvedArgs);
        case 'http':
          return await dispatchHttp(nodeId, def, resolvedArgs, deps);
        case 'mcp':
          return await dispatchMcp(nodeId, def, resolvedArgs, deps);
        default: {
          // Exhaustiveness check. If a new ToolDef variant is added
          // without updating this switch, TS catches it at compile
          // time and the runtime throws loudly rather than silently
          // returning success.
          const _exhaustive: never = def;
          throw new Error(`unsupported ToolDef kind: ${JSON.stringify(_exhaustive)}`);
        }
      }
    } catch (err) {
      // Dispatch helpers normally return errorExit() instead of
      // throwing, but a programming bug (e.g., undefined property
      // access) shouldn't take down the whole graph silently. Catch
      // here and route to error edge with a UnexpectedError tag.
      return errorExit(nodeId, 'UnexpectedError', (err as Error).message);
    }
  };
}

/**
 * Resolve step-level args. Each value is either:
 *   - an Expression (`{ kind: 'jsonpath' | 'literal' | 'js' }`) → evaluated
 *   - any other value → passed through verbatim
 *
 * Expression detection is structural: a non-null object with a string
 * `kind` field matching one of the Expression discriminator values. Plain
 * objects intended as raw args (e.g., `{ name: "foo", value: 1 }`) are
 * untouched as long as they don't accidentally use a reserved kind.
 */
function resolveStepArgs(
  args: Record<string, unknown>,
  state: FlowStateT,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = isExpression(v) ? evalExpressionToValue(v, state) : v;
  }
  return out;
}

/**
 * Like `evalExpression` but returns the raw resolved value (not a
 * boolean). Mirrors `resolveExpressionValue` in flow-graph.ts but
 * imported indirectly to keep this module's surface area smaller.
 */
function evalExpressionToValue(expr: Expression, state: FlowStateT): unknown {
  if (expr.kind === 'literal') return expr.value;
  if (expr.kind === 'jsonpath') return resolveJsonPath(expr.path, state);
  // js path delegates to evalExpression so the (consistent) "not yet
  // supported" error surfaces here too.
  evalExpression(expr, state);
  return undefined;
}

function isExpression(v: unknown): v is Expression {
  if (!v || typeof v !== 'object') return false;
  const k = (v as { kind?: unknown }).kind;
  return k === 'literal' || k === 'jsonpath' || k === 'js';
}

function resolveJsonPath(path: string, state: unknown): unknown {
  if (path === '$') return state;
  if (!path.startsWith('$.')) return undefined;
  const parts = path.slice(2).split('.');
  let cur: unknown = state;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

// ─── CLI dispatch ────────────────────────────────────────────────────────

/**
 * Spawn the CLI via execFile (no shell). Args go through `{{name}}`
 * template substitution against the resolved step-args map. The whole
 * stdout becomes `state.output` on success.
 *
 * Failure modes:
 *   - cmd not on PATH / ENOENT → UnknownExecutable
 *   - non-zero exit + not in allowExitCodes → CliError (with stderr)
 *   - timeout → Timeout (process killed)
 *
 * Stderr is captured but not surfaced on success — only embedded in
 * the error message when the call fails. Tools that need to share
 * structured stderr should write to stdout (JSON envelope).
 */
async function dispatchCli(
  nodeId: string,
  def: CliToolDef,
  args: Record<string, unknown>,
): Promise<Partial<FlowStateT>> {
  const argv = (def.args ?? []).map((tpl) => substituteTemplate(tpl, args));
  const timeoutMs = def.timeoutMs ?? DEFAULT_CLI_TIMEOUT;
  const allowedCodes = new Set([0, ...(def.allowExitCodes ?? [])]);

  return new Promise<Partial<FlowStateT>>((resolve) => {
    const child = execFile(
      def.cmd,
      argv,
      {
        cwd: def.cwd,
        env: def.env ? { ...process.env, ...def.env } : process.env,
        timeout: timeoutMs,
        killSignal: 'SIGTERM',
        // 10MB buffer cap — guards against runaway stdout. Catalog
        // authors who need streaming results should use http or mcp
        // tools, not CLI tools that emit gigabytes.
        maxBuffer: 10 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        // execFile delivers timeout via err.signal === 'SIGTERM' when
        // the process was killed by the timeout. Distinguish that from
        // a regular non-zero exit so the error edge sees a clean tag.
        // Without an explicit `encoding` option execFile resolves
        // stdout/stderr as strings, so the values arrive ready-to-use.
        const stdoutStr = stdout ?? '';
        const stderrStr = stderr ?? '';

        if (err) {
          const e = err as NodeJS.ErrnoException & { code?: string | number; signal?: string };
          if (e.code === 'ENOENT') {
            resolve(
              errorExit(nodeId, 'UnknownExecutable', `${def.cmd} not found on PATH`),
            );
            return;
          }
          if (e.signal === 'SIGTERM') {
            // Schedule SIGKILL after grace period in case the process
            // ignored SIGTERM. Belt-and-suspenders for stubborn
            // children that swallow termination signals.
            setTimeout(() => {
              try {
                child.kill('SIGKILL');
              } catch {
                // process already gone
              }
            }, SIGKILL_DELAY_MS).unref();
            resolve(
              errorExit(nodeId, 'Timeout', `CLI tool timed out after ${timeoutMs}ms`),
            );
            return;
          }
          // typeof e.code === 'number' is the actual exit code path.
          if (typeof e.code === 'number' && allowedCodes.has(e.code)) {
            resolve(successExit(nodeId, stdoutStr));
            return;
          }
          const exitCode = typeof e.code === 'number' ? e.code : -1;
          resolve(
            errorExit(
              nodeId,
              'CliError',
              `${def.cmd} exited ${exitCode}${stderrStr ? `: ${stderrStr.trim().slice(0, 500)}` : ''}`,
            ),
          );
          return;
        }

        resolve(successExit(nodeId, stdoutStr));
      },
    );
  });
}

/**
 * Replace `{{name}}` placeholders in a string template against the
 * resolved args. Missing names fail-loud (error exit) rather than
 * silently emit empty strings — a missing arg is a catalog mistake,
 * not user input we need to be lenient with.
 *
 * Non-string arg values are JSON-stringified into the slot. Catalog
 * authors who want a different serialization (e.g., shell-quoting)
 * should resolve the arg to a string via `transform` first.
 */
function substituteTemplate(template: string, args: Record<string, unknown>): string {
  // Placeholder names allow letters, digits, underscore, hyphen, and dot —
  // wide enough for kebab-case, snake_case, and dotted ids the catalog
  // commonly uses (e.g., {{repo.path}}). Anything outside that closes
  // the placeholder.
  return template.replace(/\{\{([\w.-]+)\}\}/g, (_, name) => {
    if (!(name in args)) {
      throw new Error(`tool template references missing arg "${name}"`);
    }
    const v = args[name];
    if (v == null) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

// ─── HTTP dispatch ───────────────────────────────────────────────────────

/**
 * fetch the endpoint. URL placeholders resolve against args; body is
 * the bodyTemplate with embedded jsonpath Expressions resolved against
 * state — jsonpath state-resolution happens earlier in resolveStepArgs
 * for top-level args, but bodyTemplate is independent so it gets its
 * own pass here.
 *
 * 2xx → state.output = response text. JSON responses are passed through
 * as-is (already a string from response.text()) — catalog authors who
 * need parsed access should follow with a `transform` step using
 * jsonpath into the body.
 *
 * Non-2xx → HttpError with status + truncated body.
 */
async function dispatchHttp(
  nodeId: string,
  def: HttpToolDef,
  args: Record<string, unknown>,
  deps: ToolExecutorDeps,
): Promise<Partial<FlowStateT>> {
  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  const url = substituteTemplate(def.endpoint, args);
  const timeoutMs = def.timeoutMs ?? DEFAULT_HTTP_TIMEOUT;

  const headers: Record<string, string> = { ...(def.headers ?? {}) };
  if (def.auth) {
    try {
      await applyAuthHeaders(headers, def.auth, deps.broker);
    } catch (err) {
      return errorExit(nodeId, 'AuthError', (err as Error).message);
    }
  }

  let body: string | undefined;
  if (def.method !== 'GET' && def.method !== 'DELETE' && def.bodyTemplate) {
    body = JSON.stringify(resolveBodyTemplate(def.bodyTemplate, args));
    headers['content-type'] ??= 'application/json';
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchFn(url, {
      method: def.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: ctl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const e = err as Error;
    if (e.name === 'AbortError') {
      return errorExit(nodeId, 'Timeout', `HTTP tool timed out after ${timeoutMs}ms`);
    }
    return errorExit(nodeId, 'NetworkError', e.message);
  }
  clearTimeout(timer);

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    return errorExit(
      nodeId,
      'HttpError',
      `${def.method} ${url} → ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 500)}` : ''}`,
    );
  }
  return successExit(nodeId, text);
}

/**
 * Resolve a bodyTemplate. Top-level keys whose values are Expressions
 * get evaluated against state-resolved args (which the caller passes
 * in). Nested objects pass through verbatim — full-tree expression
 * resolution would surprise catalog authors writing static JSON. A
 * future helper can add deep mode if a real use case appears.
 */
function resolveBodyTemplate(
  template: Record<string, unknown>,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(template)) {
    if (isExpression(v)) {
      // Expressions in bodyTemplate evaluate against the *args* map
      // (already state-resolved). This keeps state-touching narrow
      // to one place per call.
      if (v.kind === 'literal') {
        out[k] = v.value;
      } else if (v.kind === 'jsonpath') {
        out[k] = resolveJsonPath(v.path, args);
      } else {
        // js path: not supported here either; surface a clear error
        throw new Error('"js" expression kind is not yet supported in bodyTemplate');
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Inject auth headers into an outgoing request. Pulls the credential
 * from the broker; caller has already verified the broker exists when
 * `def.auth` is set.
 */
async function applyAuthHeaders(
  headers: Record<string, string>,
  auth: ToolAuthRef,
  broker: CredentialBroker | undefined,
): Promise<void> {
  if (!broker) {
    throw new Error(`tool requires auth but no broker is configured`);
  }
  const cred = await fetchCredential(broker, auth.credentialId);
  switch (auth.scheme) {
    case 'bearer':
      headers.authorization = `Bearer ${cred}`;
      return;
    case 'header': {
      if (!auth.name) {
        throw new Error(`scheme "header" requires auth.name`);
      }
      headers[auth.name.toLowerCase()] = cred;
      return;
    }
    case 'basic': {
      // Broker returns a single string for basic; expect "user:pass"
      // already composed (the credential store, not the runtime,
      // owns the user/pass split).
      headers.authorization = `Basic ${Buffer.from(cred).toString('base64')}`;
      return;
    }
    default: {
      const _exhaustive: never = auth.scheme;
      throw new Error(`unknown auth scheme: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * Adapt the agent-auth CredentialBroker shape to a single-string
 * lookup. The CredentialBroker's contract returns a credential
 * envelope (provider-shaped); for tool auth we want just the token
 * string, so a shim layer is appropriate. Until the broker grows a
 * dedicated tool-cred path, treat the stringified envelope as the
 * token.
 *
 * This is intentionally narrow — when the broker adds a `getToolToken`
 * call we'll switch to it without touching dispatch logic.
 */
async function fetchCredential(
  broker: CredentialBroker,
  credentialId: string,
): Promise<string> {
  // The broker may not directly expose getCredential — until that lands
  // in @ecruz165/agent-auth, we reach through a method we know exists.
  const b = broker as unknown as {
    getCredential?: (id: string) => Promise<string | { token: string }>;
  };
  if (typeof b.getCredential !== 'function') {
    throw new Error(
      `CredentialBroker has no getCredential(...) method — needed for tool auth on credentialId="${credentialId}"`,
    );
  }
  const out = await b.getCredential(credentialId);
  if (typeof out === 'string') return out;
  if (out && typeof out === 'object' && typeof out.token === 'string') return out.token;
  throw new Error(`broker returned non-string credential for "${credentialId}"`);
}

// ─── MCP dispatch ────────────────────────────────────────────────────────

/**
 * Invoke an MCP tool. v1 implementation defers to the caller via
 * `deps.mcpInvokeFn` because the @modelcontextprotocol/sdk import
 * footprint isn't worth pulling into harness-core for the small
 * fraction of catalogs that use MCP today. harness-server (which
 * already pulls the MCP SDK for agent-side use) wires a default
 * implementation and forwards it through here.
 *
 * When `deps.mcpInvokeFn` isn't set, the executor surfaces an
 * UnconfiguredMcp error rather than silently no-oping — catalog
 * authors learn early that MCP needs a host with the SDK.
 */
async function dispatchMcp(
  nodeId: string,
  def: McpToolDef,
  args: Record<string, unknown>,
  deps: ToolExecutorDeps,
): Promise<Partial<FlowStateT>> {
  if (!deps.mcpInvokeFn) {
    return errorExit(
      nodeId,
      'UnconfiguredMcp',
      `MCP tool "${def.id}" cannot dispatch — host did not provide an mcpInvokeFn`,
    );
  }
  const timeoutMs = def.timeoutMs ?? DEFAULT_MCP_TIMEOUT;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);

  let result: McpResult;
  try {
    result = await Promise.race<McpResult>([
      deps.mcpInvokeFn(def, args),
      new Promise<McpResult>((_, reject) => {
        ctl.signal.addEventListener('abort', () =>
          reject(new Error(`MCP tool timed out after ${timeoutMs}ms`)),
        );
      }),
    ]);
  } catch (err) {
    clearTimeout(timer);
    return errorExit(nodeId, 'McpError', (err as Error).message);
  }
  clearTimeout(timer);

  if (!result.ok) {
    return errorExit(nodeId, result.errorName, result.errorMessage);
  }
  return successExit(nodeId, result.content);
}

// ─── shared exit-shape helpers ───────────────────────────────────────────

function successExit(nodeId: string, output: string): Partial<FlowStateT> {
  return {
    output,
    lastExit: { nodeId, kind: 'success' },
  };
}

function errorExit(
  nodeId: string,
  errorName: string,
  errorMessage: string,
): Partial<FlowStateT> {
  return {
    lastExit: { nodeId, kind: 'error', errorName, errorMessage },
  };
}

/**
 * Re-export wrapper so tests can build the executor without
 * round-tripping through the orchestrator. Kept thin — main entry is
 * `makeToolExecutor`.
 */
export type { ToolDef, ToolResolver } from './catalog.ts';
