# agent-adapter — Implementation PRD

**Status:** Draft (2026-04-30)
**Owner:** Edwin Cruz
**Audience:** future implementer (human or agent) picking this up cold
**Reference impl:** `.plans/2026-04-30-agentic-harness-design.md` § 6.1–6.4 (`AgentAdapter`, `AdapterFactory`, `AgentSpec`, `AgentInvocationResult`)
**Sibling lib:** `npm-dependency/auth-lib/` — supplies credentials this lib consumes

---

## 1. Purpose

A standalone, host-agnostic TypeScript library that exposes a single uniform interface for invoking an "agent" — and lets the host swap the underlying runtime (Claude SDK in-process, `claude-code` CLI subprocess, `opencode` CLI subprocess, GitHub Copilot Chat HTTP API, `gh copilot` CLI subprocess, OpenAI SDK, future backends) by changing one config field.

The library extracts and generalizes the adapter subsystem already designed into `agentic-harness`. By making it a standalone package:

1. **Hosts other than the harness** (mtauth-installer-cli, one-off agent scripts) get a polished agent abstraction without inheriting pipelines, memory, context, profiles, or LangGraph.
2. **The harness becomes a consumer**, not the owner. Adapter improvements ship to all hosts on one bump.
3. **Adapter authors ship plugins** (`@your-org/agent-adapter-bedrock`, `@your-org/agent-adapter-cursor-cli`) without forking the harness.
4. **Per-backend quirks are encapsulated** — claude-code's `--output-format=stream-json` line parsing, opencode's session-resume semantics, Claude SDK's tool-use turn loop — none of that leaks to the host.

**Why now:** The harness PRD names three concrete adapters (`claude-sdk`, `opencode-cli`, `openai`); v1 of this lib expands that to five (adding `claude-code-cli`, `copilot-sdk`, `copilot-cli`) and defers `openai` to v1.1. None have been written yet. Extracting the package *before* implementation keeps the harness from acquiring import paths into adapter internals that would later need un-tangling.

## 2. Goals (v1)

- **Single uniform interface** (`AgentAdapter`) the host invokes, regardless of backend.
- **Five built-in adapters** for v1: `claude-sdk`, `claude-code-cli`, `opencode-cli`, `copilot-sdk`, `copilot-cli`. (OpenAI SDK adapter ships in v1.1.) The two Copilot adapters round out provider coverage for shops standardized on GitHub Copilot, and `copilot-sdk` validates the SDK adapter pattern across providers (Anthropic + GitHub) before OpenAI lands.
- **Sync invoke + async stream** verbs. Both required on every adapter; CLIs bridge stdout to async iterable.
- **Normalized request shape** (`AgentInput` — messages, system prompt, max tokens, temperature, tools spec) and normalized response shape (`AgentInvocationResult` — content, token usage, finish reason, capture).
- **Capability declaration** per adapter (`AdapterCapabilities`) so hosts can ask "does this adapter support tool use / streaming?" without trial-and-error.
- **Process lifecycle for CLI adapters** — spawn, stdio piping, line-buffered JSON parsing, graceful + forced shutdown, exit-code → error mapping.
- **Cancellation** via `AbortSignal` — works uniformly across in-process (SDK) and out-of-process (CLI) backends.
- **Auth via auth-lib** (optional injection) — adapter receives `CredentialBroker`, fetches the right credential at invoke time. Host can also pre-resolve and pass an API key directly.
- **Pluggable adapter registry** — `registerAdapter(factory)` lets consumers add custom backends without modifying the lib.

## 3. Non-Goals (v1)

- **Not a pipeline orchestrator.** No phases, no profiles, no memory. That's the harness's job; this lib is one layer below.
- **Not a multi-process coordinator.** The lib spawns *one* CLI subprocess per `agent.invoke()` (or makes *one* in-process call for SDK / HTTP adapters) — never more. Parallel work delegation, subagent fan-out, and multi-terminal session management are owned by `agentic-worker-lib`: a worker runs a coordinator skill, and when that skill decides to fan work out, **the agent itself** (via the skill, using its own Bash/tool surface) spawns tmux sessions — each running another worker that constructs *its own* `agent-adapter` instance for *its own* single invocation. The same shape recurses: a subagent worker can run its own coordinator skill and spawn further tmux sessions, indistinguishable from the root case. Adapters are leaves of the worker tree, not branches: they have no knowledge of tmux, peer workers, depth in the tree, or coordination state, and the public API has no `spawnPeer`/`fanOut`/`subagent` surface.
- **Not a tool implementation registry.** The lib forwards tool *definitions* to backends that support them and surfaces tool-use *events* in the stream — but the host implements the tools' actual behavior. (Defer "shared tool registry" to harness or a separate `@your-org/tools-lib`.)
- **No MCP support.** MCP use is against corporate policy in target deployments. The lib does not expose, proxy, discover, or accept MCP server definitions on its API surface, and adapters that wrap MCP-capable tools must ensure those tools do not load MCP config at runtime.
- **Not a model router / fallback layer.** Each adapter targets exactly one backend; if you want fallback, wrap two adapters yourself.
- **Not a prompt template system.** Inputs are arrays of `{ role, content }` messages.
- **Not a cost estimator.** Lib reports `usage` (tokens); pricing tables live in the consumer or a sibling lib.
- **Not a telemetry collector.** Lib emits a `usage` event after each invocation; consumer wires it to their logger / OTel exporter.
- **Not a session manager.** v1 is invocation-scoped; cross-invocation session continuity (`--continue`, `--resume`) deferred to v1.1. (See § 13 Q1.)

## 4. Reference & Provenance

The lib begins as a **clean-room extraction** of the harness's adapter subsystem. Source of truth (no code yet, only design):

| Section in harness design doc | Reuse as |
|---|---|
| § 6.1 `AgentAdapter` interface | Top-level public interface — drop the `extends Runnable` LangChain dependency (see § 13 Q5) |
| § 6.2 `AdapterFactory` interface | Public registration API |
| § 6.3 `AgentSpec` discriminated union + per-backend specs | Public types |
| § 6.3 Normalized verb mapping (maxTokens, temperature, reasoningEffort, etc.) | Reuse table verbatim |
| § 6.4 `AgentInvocationResult` + `TokenUsage` + `AgentCapture` | Public output types |

**Hardcoded values to think about during extraction:**
- LangChain `Runnable` interface dependency (harness uses LangGraph; this lib should not). Lib defines its own `invoke` / `stream` directly. Adapter for LangGraph compatibility ships separately if the harness wants it.
- Harness-specific config plumbing (`HarnessConfigurable` in the `RunnableConfig.configurable` slot) — replaced with a simpler `InvokeOptions` parameter.
- Capture sink integration (harness has `CaptureSink`) — lib emits captures in the result; consumer pipes them anywhere.

## 5. Package Layout

| | |
|---|---|
| Path | `npm-dependency/agent-adapter/` |
| Package name | `@your-org/agent-adapter` |
| Lang | TypeScript, Node ≥20, ESM |
| Test runner | `vitest` |
| Runtime deps | `zod`, `@anthropic-ai/sdk` (peer optional), `@anthropic-ai/claude-agent-sdk` (peer optional) |

```
agent-adapter/
├── src/
│   ├── index.ts                       # public exports
│   ├── create-agent.ts                # createAgent(spec, deps) factory; main entry point
│   ├── types.ts                       # AgentAdapter, AgentSpec, AgentInput, AgentInvocationResult
│   ├── capabilities.ts                # AdapterCapabilities + intersection helpers
│   ├── registry.ts                    # built-in registry + registerAdapter()
│   ├── stream.ts                      # AgentChunk types + stream merge helpers
│   ├── errors.ts                      # AdapterError taxonomy
│   ├── adapters/
│   │   ├── claude-sdk/
│   │   │   ├── index.ts               # ClaudeSdkAdapter (uses @anthropic-ai/sdk)
│   │   │   └── normalize.ts           # request/response shape mapping
│   │   ├── claude-code-cli/
│   │   │   ├── index.ts               # ClaudeCodeCliAdapter (spawn `claude`)
│   │   │   ├── stream-parser.ts       # line-buffered stream-json parser
│   │   │   └── flags.ts               # AgentSpec → claude-code CLI flags
│   │   ├── opencode-cli/
│   │   │   ├── index.ts               # OpenCodeCliAdapter (spawn `opencode`)
│   │   │   ├── stream-parser.ts
│   │   │   └── flags.ts
│   │   ├── copilot-sdk/
│   │   │   ├── index.ts               # CopilotSdkAdapter (HTTP to api.githubcopilot.com)
│   │   │   ├── normalize.ts           # OpenAI-compatible request/response shape mapping
│   │   │   ├── headers.ts             # Copilot API contract headers (hardcoded; see § 8.4)
│   │   │   └── sse-parser.ts          # SSE → AgentChunk for streaming completions
│   │   ├── copilot-cli/
│   │   │   ├── index.ts               # CopilotCliAdapter (spawn `gh copilot`)
│   │   │   ├── stream-parser.ts
│   │   │   └── flags.ts
│   │   └── shared/
│   │       └── child-process.ts       # spawn + stdio + abort wiring (used by all CLI adapters)
│   ├── credentials/
│   │   └── broker.ts                  # CredentialBroker interface (compat with auth-lib)
│   └── conformance/                   # EXPORTED as @your-org/agent-adapter/conformance —
│       ├── index.ts                   #   reusable suite that any adapter author can run
│       ├── scenarios.ts               #   echo, multi-turn, abort, tool-use, malformed input
│       └── fixtures/                  #   canned CLI stdout transcripts (shared with tests)
├── test/
│   ├── unit/
│   └── conformance.test.ts            # imports src/conformance, runs it against built-in adapters
├── package.json
├── tsconfig.json
└── README.md
```

The **conformance suite** is the keystone: a single test file driving every registered adapter through a fixed scenario set (echo prompt, multi-turn, abort mid-stream, tool-use turn, malformed input). If a new adapter passes the suite, it's swap-compatible by definition.

## 6. Public API

```ts
import { createAgent } from '@your-org/agent-adapter';
import { createAuthClient } from '@your-org/auth-lib';

const auth = createAuthClient({ appName: 'my-cli' });

const agent = createAgent({
  spec: {
    type: 'claude-code-cli',
    model: 'claude-sonnet-4-6',
    systemPrompt: 'You are a code reviewer.',
  },
  workdir: '/path/to/checked-out/repo',  // REQUIRED, must be a git working tree
  credentialBroker: auth,                 // optional — see § 12
  logger: console,                        // optional
});

// Synchronous invoke
const result = await agent.invoke({
  messages: [{ role: 'user', content: 'Review src/foo.ts' }],
});

console.log(result.content);              // assistant text
console.log(result.usage);                // { inputTokens, outputTokens, ... }
console.log(result.finishReason);         // 'stop' | 'length' | 'tool_use' | ...

// Streaming
for await (const chunk of agent.stream({ messages: [...] })) {
  if (chunk.type === 'text-delta')       process.stdout.write(chunk.text);
  if (chunk.type === 'tool-call-start')  console.log(`\n[tool: ${chunk.toolName}]`);
  if (chunk.type === 'usage')            console.log(chunk.usage);
}

// Cancellation
const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), 5000);
await agent.invoke({ messages: [...] }, { signal: ctrl.signal });

// Capability check before invoking
if (!agent.capabilities.supportsToolUse) {
  throw new Error('This adapter cannot run tools');
}
```

### Swap the backend

```ts
// Same call, different runtime — only spec.type changes:
const agent = createAgent({ spec: { type: 'opencode-cli', model: '...' }, workdir, ... });
const agent = createAgent({ spec: { type: 'claude-sdk',   model: '...' }, workdir, ... });
```

This is the headline contract: **changing `spec.type` is the only edit needed to swap the runtime.** Everything else — `workdir`, `credentialBroker`, invoke, stream, abort, usage — is identical. `workdir` is deliberately top-level (not inside `spec`) so it stays put across swaps.

### Mountable CLI helper (optional)

```ts
import { mountAgentCommand } from '@your-org/agent-adapter/cli';
import { Command } from 'commander';

mountAgentCommand(program, () => agent);  // adds `<bin> ask <prompt>` for quick smoke tests
```

## 7. Core Types

```ts
// --- createAgent factory args ---

export interface CreateAgentArgs {
  spec: AgentSpec;                                         // describes the agent (model, system, etc.)
  workdir: string;                                         // REQUIRED — must be a git working tree (see § 7.1)
  credentialBroker?: CredentialBroker;                     // optional, supplies provider credentials
  logger?: Logger;                                         // optional
  signal?: AbortSignal;                                    // optional, aborts construction (e.g., binary-version check)
}

// --- Public interface ---

export interface AgentAdapter {
  readonly type: AgentSpecType;                           // 'claude-sdk' | 'claude-code-cli' | ...
  readonly capabilities: AdapterCapabilities;
  readonly workdir: string;                                // resolved absolute path; available for telemetry/metadata

  invoke(input: AgentInput, opts?: InvokeOptions): Promise<AgentInvocationResult>;
  stream(input: AgentInput, opts?: InvokeOptions):  AsyncIterable<AgentChunk>;
}

export interface AgentInput {
  messages: ChatMessage[];                                 // role + content (string | content blocks)
  systemPrompt?: string;
  tools?: ToolDefinition[];                                // omitted when adapter doesn't support
  toolChoice?: 'auto' | 'none' | { name: string };
}

export interface InvokeOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  capture?: boolean;                                       // include request/response in result
}

export interface AgentInvocationResult {
  content: string;                                         // primary assistant text
  contentBlocks?: ContentBlock[];                          // structured (text, tool-use, thinking)
  usage?: TokenUsage;
  finishReason?: 'stop' | 'length' | 'tool_use' | 'content_filter' | 'aborted' | 'error';
  capture?: AgentCapture;                                  // only when opts.capture === true
  durationMs: number;
}

// --- Adapter capabilities ---

export interface AdapterCapabilities {
  reportsUsage:           boolean;
  supportsStreaming:      boolean;
  supportsToolUse:        boolean;
  supportsExtendedThinking: boolean;
  supportsCancellation:   boolean;
  supportsCapture:        boolean;
  // Whether the adapter accepts a JSON-mode / structured-output request flag
  // (e.g., OpenAI's `response_format: { type: 'json_object' }`). Anthropic
  // models don't expose JSON mode — use tool-use with a JSON schema instead,
  // which is why claude-* adapters report `false` even though they can produce
  // structured output by other means.
  // For multi-backend transports (Copilot), this is resolved at construction
  // by inspecting `spec.model` against a known-models allowlist; see § 8.4.
  supportsJsonMode:       boolean;
  // Whether the adapter can be swapped out *during* a session (not in v1).
  supportsSessionResume:  boolean;
}

// --- Stream chunks ---

export type AgentChunk =
  | { type: 'text-delta';        text: string }
  | { type: 'thinking-delta';    text: string }
  | { type: 'tool-call-start';   toolCallId: string; toolName: string }
  | { type: 'tool-call-input';   toolCallId: string; partialInput: string }
  | { type: 'tool-call-end';     toolCallId: string; input: unknown }
  | { type: 'tool-result';       toolCallId: string; output: unknown }
  | { type: 'message-stop';      finishReason: AgentInvocationResult['finishReason'] }
  | { type: 'usage';             usage: TokenUsage }
  | { type: 'error';             error: AdapterError };
```

The stream chunk taxonomy is the **second-most load-bearing decision** after the public interface. It must cover what every backend emits (Anthropic SDK's stream events, claude-code's `stream-json` lines, opencode's TBD format) without introducing backend-specific shapes.

### 7.1 Workdir contract

Every agent is constructed bound to a **`workdir`**, which the lib treats as the agent's repo of record. The contract:

- **Required** — every adapter (including SDK) accepts `workdir`. Hosts that don't manage repos still pass *some* directory; type system enforces presence.
- **Must be a git working tree** — validated at `createAgent` time via `git -C <workdir> rev-parse --is-inside-work-tree`. Throws `WorkdirNotARepoError` on failure with a remediation hint. (Worktrees and submodules count; `.git/` directory presence alone does not — git's own check is authoritative.)
- **Pipeline-supplied** — the host (typically the harness's worktree allocator) decides which checkout an agent runs against. The lib does *not* clone, fetch, or mutate the workdir. It reads it for spawn `cwd` (CLI adapters) and metadata (all adapters).
- **Repo metadata captured at construction** — lib resolves `repoRoot`, `commit` (`HEAD` SHA), and `branch` once, attaches them to every emitted event/capture/error so observability is automatic.
- **Immutable per agent instance** — to change workdir, construct a new agent. Prevents mid-session drift.

## 8. Adapter Implementations

### 8.1 `claude-sdk` (in-process)

- Depends on `@anthropic-ai/sdk` (declared `peerDependency`; lib doesn't bundle).
- `invoke` → `client.messages.create({ ...spec, ...input })`.
- `stream` → `client.messages.stream({ ...spec, ...input })` → re-emit as `AgentChunk`.
- Tool use: passes `tools` array to SDK, surfaces tool-use blocks as `tool-call-end` chunks. Host runs the tool and *re-invokes with tool result message* — the adapter is invocation-scoped, not loop-scoped. (See § 13 Q2.)
- Auth: requests `anthropic` credential from broker, sets `apiKey` on the SDK client. Falls back to `ANTHROPIC_API_KEY` if no broker.
- Workdir: required like every adapter. Not used as `cwd` (no subprocess), but captured into telemetry/metadata as `repoRoot`/`commit`/`branch` so logs from this adapter remain comparable to CLI adapters running against the same repo.
- Capabilities: all `true` except `supportsJsonMode` (Anthropic does not expose a JSON mode — use tool-use with a JSON schema for structured output) and `supportsSessionResume`.

### 8.2 `claude-code-cli` (subprocess)

- **Sandbox:** Spawns with `$HOME` and `$TMPDIR` redirected to the job's `workdir` to ensure 100% state isolation and prevent leakage into the host's global `~/.claude` or `/tmp`.
- Spawns `claude --print --output-format=stream-json --input-format=stream-json` (or equivalent).
- Pipes input messages as JSON over stdin; reads stream-json events from stdout.
- `stream-parser.ts` reassembles the line-buffered events into `AgentChunk`s.
- Working directory: the top-level `workdir` (validated git working tree, see § 7.1) becomes the spawn `cwd`. Tools (Read, Edit, Bash) operate within this directory.
- Auth: because `$HOME` is sandboxed to the workdir, claude-code's own auth state (`~/.claude/auth.json`) is **not visible** to the spawned process — the sandbox and a filesystem auth probe are mutually exclusive. Credentials are propagated **via `containerEnv`**: the host resolves an Anthropic credential (typically `broker.getCredential('anthropic')`) and the adapter injects it as `ANTHROPIC_API_KEY` into the child process env. The adapter **validates at `createAgent` time** that a usable credential was resolved and throws `MissingCredentialError` synchronously if not — failures surface at construction, never mid-stream. Interactive `claude /login` flows are owned by the host's CLI/TUI; once the user authenticates there, the resolved tokens propagate through the harness's memory, context, and harness-server layers to whichever adapter spawns next. The adapter never initiates an interactive flow.
- Capabilities: `reportsUsage: true`, `supportsToolUse: true`, `supportsStreaming: true`, `supportsCancellation: true` (SIGTERM), `supportsExtendedThinking: true`, `supportsCapture: true`, `supportsJsonMode: false` (claude-code wraps Anthropic models, which have no JSON mode), `supportsSessionResume: false` (in v1; CLI supports `--resume` but we defer surfacing it).

### 8.3 `opencode-cli` (subprocess)

- Spawns `opencode --print --json` (verify exact flags during implementation; the upstream is younger and flag set is less stable than claude-code's).
- Same general shape as claude-code-cli adapter; differences are quirks of opencode's stdout format.
- Auth: same `containerEnv`-based propagation as claude-code-cli (see § 8.2 and § 12). Sandboxed `$HOME` means opencode's own auth state is unreachable from the spawn; the host resolves the credential, the adapter injects whichever env var opencode reads (verify the exact name during Phase D), and validation throws `MissingCredentialError` at `createAgent` time. Interactive auth lives in the host's CLI/TUI.

### 8.4 `copilot-sdk` (in-process, HTTP)

A direct HTTP adapter against GitHub Copilot's Chat API (`https://api.githubcopilot.com/chat/completions`). The endpoint is OpenAI-compatible (request/response shapes match `chat/completions`), so `normalize.ts` maps `AgentInput` → OpenAI request body and the response → `AgentInvocationResult`.

- **No SDK package** — uses `fetch` directly. Copilot doesn't ship an official Node SDK; auth-lib's existing `callCopilot` (per auth-lib § 12.2) is the reference implementation. The adapter consolidates the HTTP call but does *not* re-implement the GitHub-token → Copilot-token exchange — that's auth-lib's job, surfaced through `broker.getCredential('copilot')` which returns the *Copilot* token (not the underlying GitHub token).
- **Auth:** `broker.getCredential('copilot')` returns `{ apiKey: <copilot-token>, expiresAt }`. Copilot tokens are short-lived (~30min); the broker (auth-lib's `AuthClient`) handles refresh transparently. The adapter sets `Authorization: Bearer <token>` and forwards. Falls back to `COPILOT_TOKEN` env var if no broker, but discouraged — token rotation is the broker's responsibility.
- **Headers (Copilot API contract — hardcoded in `headers.ts`, NOT parameterizable):**
  - `User-Agent: GithubCopilot/1.155.0`
  - `Editor-Version: <consumer-supplied user agent>`
  - `Editor-Plugin-Version: copilot.vim/1.16.0`
  - `Copilot-Integration-Id: vscode-chat`
  - `Openai-Intent: conversation-panel`
  - Getting any of these wrong returns 403 with no useful body. The adapter logs all five at DEBUG on every call so a misconfigured deployment is auditable.
- **`invoke` →** single POST, parse JSON response, build `AgentInvocationResult`.
- **`stream` →** POST with `stream: true`; SSE parser (`sse-parser.ts`) consumes `data: {...}\n\n` chunks and emits `AgentChunk`s (mirrors OpenAI's chunk shape: `choices[0].delta.content` → `text-delta`).
- **Tool use:** Copilot Chat API supports OpenAI-style function calling. Adapter forwards `tools` array and surfaces `tool_calls` deltas as `tool-call-*` chunks. Same invocation-scoped tool loop as `claude-sdk` (host re-invokes with tool-result messages).
- **Workdir:** required like every adapter. Captured into telemetry/metadata; not used as `cwd` (no subprocess).
- **Models:** Copilot Chat exposes `gpt-4o`, `gpt-4o-mini`, `o1-mini`, `claude-sonnet-4-...` and others; the adapter passes `spec.model` through verbatim. `agent.listModels()` (if added) would call `GET /models` on the Copilot endpoint.
- **Capabilities:** `reportsUsage: true` (Copilot returns OpenAI-style `usage` block), `supportsStreaming: true`, `supportsToolUse: true` (custom tools — unlike CLI adapters), `supportsExtendedThinking: false` (Copilot doesn't expose thinking deltas), `supportsCancellation: true` (AbortSignal aborts the fetch), `supportsCapture: true`, `supportsJsonMode`: **resolved at construction from `spec.model`** — `true` for OpenAI-family models that accept `response_format` / structured outputs (`gpt-4o`, `gpt-4o-mini`, `o1-mini`, etc.), `false` when routing to Anthropic-family models on Copilot (e.g. `claude-sonnet-4-...`) where structured output flows through tool-use. The allowlist lives in `headers.ts`'s sibling `models.ts` so it's the single source of truth as Copilot adds models. `supportsSessionResume: false` (Copilot Chat is invocation-scoped server-side).

### 8.5 `copilot-cli` (subprocess, **limited capability**)

Wraps the official GitHub `gh copilot` CLI extension. **Constrained scope:** `gh copilot` exposes only `suggest <prompt>` (shell-command suggestion) and `explain <command>` (command explanation) — it is *not* a general-purpose chat interface. Including this adapter for completeness and for narrow use cases (e.g., a phase that needs to translate "find files modified yesterday" into a `find` invocation), but consumers wanting full Copilot capabilities should use `copilot-sdk`.

- Spawns `gh copilot suggest --target=shell <prompt>` (or `--target=git`/`--target=gh` per `spec.subcommand`); single-turn, non-streaming output.
- **Sandbox:** spawns with `$HOME` and `$TMPDIR` redirected to the job's `workdir` (same pattern as `claude-code-cli`) to keep `gh`'s state isolated from the host's `~/.config/gh`.
- **Auth:** because `$HOME` is sandboxed to the workdir, `gh`'s own credential store (`~/.config/gh`) is unreachable from the spawned process — `gh auth status` cannot be the auth probe. Credentials are propagated **via `containerEnv`**: the host resolves a GitHub credential (typically `broker.getCredential('github')`) and the adapter injects it as `GH_TOKEN` into the child env. `gh` honors `GH_TOKEN` over its keyring, so this is the supported injection path. The adapter validates at `createAgent` time and throws `MissingCredentialError` if absent. `gh auth login` flows belong to the host's CLI/TUI; tokens propagate through the harness's memory, context, and harness-server layers.
- **Tool use:** **not supported.** The CLI is single-turn shell-suggestion; there's no tool-call protocol to surface. `supportsToolUse: false`.
- **Streaming:** **not supported.** `gh copilot` prints the suggestion as a single block; the adapter wraps it in one synthetic `text-delta` chunk + `message-stop` so the streaming contract holds, but it's not incremental.
- **Capabilities:** `reportsUsage: false` (the CLI doesn't report tokens), `supportsStreaming: false` (single-block output), `supportsToolUse: false`, `supportsExtendedThinking: false`, `supportsCancellation: true` (SIGTERM), `supportsCapture: true` (full stdout transcript), `supportsJsonMode: false` (`gh copilot suggest` is a single-turn shell-suggestion CLI with no `response_format` parameter to surface — the underlying model varies and is not addressable from the adapter), `supportsSessionResume: false`.
- **Conformance suite:** this adapter intentionally does **not** pass the full conformance suite — scenarios requiring tool use or streaming are skipped via a documented `skipScenarios: ['tool-use', 'multi-turn']` opt-out in the adapter's conformance manifest. This is the first case validating the suite's "limited adapter" path; treat it as the reference for any future shell-only adapters.

### 8.6 (Future) `openai` SDK adapter

Out of scope for v1 but the package layout already reserves `adapters/openai/`. v1.1. When shipped, the adapter will report `supportsJsonMode: true` — OpenAI exposes `response_format: { type: 'json_object' }` for general JSON mode plus structured-output (`response_format: { type: 'json_schema', ... }`) for newer models (`gpt-4o`, `gpt-4o-mini`, `o1`).

### 8.7 Adapter capability matrix (v1)

| Capability | claude-sdk | claude-code-cli | opencode-cli | copilot-sdk | copilot-cli |
|---|---|---|---|---|---|
| reportsUsage | ✓ | ✓ | TBD (verify opencode emits usage in JSON output) | ✓ | ✗ |
| supportsStreaming | ✓ | ✓ | ✓ | ✓ (SSE) | ✗ (single-block) |
| supportsToolUse | ✓ | ✓ (built-in tools; host can't add) | ✓ (built-in tools; host can't add) | ✓ (custom tools — OpenAI-style function calling) | ✗ |
| supportsExtendedThinking | ✓ | ✓ | TBD | ✗ | ✗ |
| supportsCancellation | ✓ (AbortSignal) | ✓ (SIGTERM) | ✓ (SIGTERM) | ✓ (AbortSignal) | ✓ (SIGTERM) |
| supportsCapture | ✓ | ✓ (transcript file) | ✓ (transcript file) | ✓ | ✓ (stdout transcript) |
| supportsJsonMode | ✗ (Anthropic uses tool-use for structured output) | ✗ (wraps Anthropic) | ✗ (wraps Anthropic / non-OpenAI) | model-dependent — ✓ for OpenAI-family `spec.model`, ✗ for Anthropic-family on Copilot | ✗ (no `response_format` surface) |
| supportsSessionResume | ✗ (v1.1) | ✗ (v1.1) | ✗ (v1.1) | ✗ (server-side invocation-scoped) | ✗ |

Cells marked TBD must be verified during Phase A implementation against the upstream tool versions targeted.

## 9. CLI Process Lifecycle

The hardest part of the lib is making CLI subprocesses feel like SDK calls. `adapters/shared/child-process.ts` centralizes the patterns; all CLI adapters use it.

**Single-spawn invariant.** Every CLI adapter spawns *exactly one* subprocess per `agent.invoke()` / `agent.stream()` call — the wrapped LLM CLI itself (`claude`, `opencode`, `gh copilot`). The adapter never spawns auxiliary helpers, sidecars, tmux sessions, or peer-worker processes. Process fan-out for parallel agent work belongs to `agentic-worker-lib` (see § 3 Non-Goals): a worker's coordinator skill issues the tmux commands, each new tmux session runs another worker, and each worker constructs its own adapter for its own single invocation. From the adapter's vantage the world is always one parent ↔ one child; depth in the worker tree is invisible.

**Spawn:**
- `spawn(binary, args, { cwd, env: { ...process.env, ...spec.env }, stdio: ['pipe', 'pipe', 'pipe'] })`.
- Resolve `binary` via `spec.binaryPath || which(toolName)`. Throw clear `BinaryNotFoundError` with install hint if missing.
- Validate the binary version on first spawn (cache result for the lib's lifetime); warn if older than the tested version.

**Streaming:**
- `stdout` is line-buffered; each line is a JSON object (or in-progress JSON for tool-call deltas — depends on the tool's protocol).
- Stream parser maintains a small state machine; on each complete event, emits one or more `AgentChunk`s.
- `stderr` is captured into a ring buffer (last 64KB). Non-fatal warnings are forwarded to the lib's logger; fatal errors get attached to the thrown `AdapterError`.

**Cancellation:**
- `AbortSignal.aborted` → send `SIGTERM`, wait 2s, then `SIGKILL` if still alive.
- After cancel, the result/stream resolves/closes with `finishReason: 'aborted'`. The host's `await` returns; no exception unless they passed `throwOnAbort: true`.

**Exit-code mapping:**
- Exit 0 → success (already produced result).
- Exit non-zero with parsed final event → use the event's error info.
- Exit non-zero with no final event → throw `AdapterError` with last 4KB of stderr.

**Crash recovery:**
- The lib does **not** auto-retry. Crashes propagate. Hosts that want retry wrap `agent.invoke` themselves (or use the harness, which has retry policies).

## 10. Streaming Model

Three producers (SDK events, claude-code stream-json lines, opencode JSON output) → one consumer shape (`AsyncIterable<AgentChunk>`).

**Backpressure:** The async iterable is push-driven via an internal queue. If the consumer is slow, the queue grows; we cap at 1000 chunks and start dropping `text-delta` chunks (most lossy-tolerant) with a warning. Tool-call and message-stop chunks are never dropped.

**Reconnection on transient failures:** Not in v1. A dropped connection / dead subprocess fails the stream.

**Stream-to-result reduction:** `invoke` is implemented as `stream` + accumulator. The accumulator concatenates `text-delta`s into `content`, builds `contentBlocks` from start/end events, and pulls the final `usage` and `finishReason` out of the closing chunks. This guarantees `invoke` and `stream` produce identical end-states for the same input.

## 11. Tool Use

**v1 contract (intentionally narrow):**
- Adapters that report `supportsToolUse: true` accept a `tools` array on `AgentInput` and emit `tool-call-*` chunks during streaming.
- The host is responsible for executing the tool and sending the result back. The mechanism for sending tool results varies:
  - `claude-sdk`: host calls `agent.invoke(...)` again with the previous turn's `tool_use` block plus a new `tool_result` block in the message history. (Standard Anthropic tool loop.)
  - `copilot-sdk`: same pattern as `claude-sdk` but with OpenAI-style `tool_calls` / `role: 'tool'` message shape. Copilot Chat API accepts arbitrary `tools` definitions, so hosts *can* inject custom tools (unlike the CLI adapters below).
  - `claude-code-cli` / `opencode-cli`: host **cannot inject custom tool definitions** in v1. The CLI's built-in tools (Read, Edit, Bash, etc.) execute autonomously inside the subprocess; the lib surfaces them as `tool-call-end` events for observability only.
  - `copilot-cli`: tool use is **not supported at all** (`supportsToolUse: false`). `gh copilot` is a single-turn shell-suggestion CLI; there is no tool-call protocol to surface.

## 12. Auth Integration

Loose coupling with `auth-lib`:

```ts
// Tightest coupling: pass the auth client itself
createAgent({ spec, credentialBroker: authClient });

// Looser: pass a function
createAgent({ spec, credentialBroker: { getCredential: async (provider) => ({ apiKey: '...' }) } });

// Loosest: pre-resolve and pass the key
createAgent({ spec: { type: 'claude-sdk', model: '...', apiKey: process.env.ANTHROPIC_API_KEY } });
```

The `CredentialBroker` interface in `src/credentials/broker.ts` is a structural subset of auth-lib's `AuthClient`:

```ts
export interface CredentialBroker {
  getCredential(provider: string): Promise<{ apiKey: string; expiresAt?: Date }>;
}
```

This means **the lib has no hard dependency on auth-lib** — it just looks for an object with `getCredential`. Auth-lib happens to satisfy it. Hosts that don't use auth-lib can pass any compatible object.

**Sandboxed CLI adapters and credential propagation.** CLI adapters that redirect `$HOME` and `$TMPDIR` for state isolation (`claude-code-cli` § 8.2, `opencode-cli` § 8.3, `copilot-cli` § 8.5) cannot read the host's auth state from inside the spawn — the sandbox and a filesystem auth probe are mutually exclusive. Credentials therefore flow through **`containerEnv`**: the host resolves the credential via `broker.getCredential(...)` and the adapter injects it as the env var the wrapped CLI reads (e.g. `ANTHROPIC_API_KEY`, `GH_TOKEN`). The adapter **validates at `createAgent` time** that the broker returned a usable credential and throws `MissingCredentialError` synchronously if not — failures are construction-time, not mid-stream, and follow the same fail-fast pattern as `BinaryNotFoundError` and `WorkdirNotARepoError`. Interactive authentication (`claude /login`, `gh auth login`, etc.) is owned by the host's CLI/TUI; once the user authenticates there, the resolved tokens propagate through the harness's memory, context, and harness-server layers to whichever adapter spawns next. The adapter never initiates an interactive flow.

## 13. Decisions

### Decided (v1)

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | Session continuity | **v1 stateless invoke only; v1.1 adds `agent.session()` with `--continue` / `--resume` semantics** | Stateless first keeps v1 small and testable; sessions are meaningful UX for CLI backends and worth doing right as additive surface. |
| D2 | Tool-loop ownership | **Host runs the loop in v1; adapter-side `agent.registerTool()` sugar in v1.1** | SDK's tool loop is genuinely multi-step; host visibility into each step is more useful than convenience. CLI adapters' built-in tools already self-loop. |
| D3 | Capability mismatch | **Throw `CapabilityMismatchError` at `createAgent` time** when the spec asks for capabilities the adapter doesn't have | Fail fast at construction. Hosts wanting graceful degradation check `agent.capabilities` first; lib never silently drops user input. |
| D4 | LangChain `Runnable` compat | **Core lib is LangChain-free; companion package `@your-org/agent-adapter-langchain` ships separately** | LangChain is a heavy peer dep most consumers don't need. Companion wrapper is two-screen code and keeps core lean. |
| D5 | Conformance suite exposure | **Exported as `@your-org/agent-adapter/conformance` (lives at `src/conformance/`)** | Tiny extra surface, huge ecosystem leverage. Third-party adapter authors run one command to prove parity. |
| D6 | Workdir semantics | **Required top-level arg, must be a git working tree (§ 7.1)** | Resolved by user input. Pipeline-supplied; SDK adapter accepts it for telemetry uniformity even though no `cwd` is used. |
| D7 | Sandboxed-CLI credential flow | **Host owns auth flow; adapter injects credentials via `containerEnv` and validates at `createAgent` time (§ 8.2, § 8.3, § 8.5, § 12)** | Sandboxing `$HOME`/`$TMPDIR` makes the wrapped CLI's own auth store unreachable, so a filesystem auth probe is incompatible with the sandbox. Inverting the flow (host pushes credentials, adapter receives) is the only consistent resolution, and construction-time validation collapses failures to one place. Interactive auth lives in the host's CLI/TUI; tokens propagate through the harness's memory, context, and harness-server layers. |
| D8 | Subprocess-spawn ownership | **Adapter spawns exactly one CLI subprocess per invocation; tmux / subagent / parallel-delegation is `agentic-worker-lib`'s job (§ 3, § 9)** | Putting fan-out in the adapter would force every adapter to grow a process-pool / IPC / output-mux subsystem and would silently change parallelism semantics across `spec.type` swaps — breaking the "swap a field, change runtime" promise. Worker-layer ownership keeps adapters single-spawn and keeps the recursion uniform: a worker runs a coordinator skill, the agent inside spawns tmux for fan-out, each child tmux runs another worker that constructs its own adapter. Adapters are leaves of the worker tree, never branches. |

### Open

| # | Question |
|---|---|
| O1 | **First consumer for v1.** Harness first (original design home), or a smaller CLI host first (smaller test bed)? The "swap a field, change runtime" promise is only credible after at least one host has actually exercised two backends — so v1 polish should be driven by whichever consumer most needs adapter-swap as a user-visible feature (likely a CLI letting end-users choose between claude-code and opencode). |

## 14. Implementation Phases

**Phase A — Skeleton + types** (~1 day)
1. Package skeleton (`package.json`, `tsconfig.json`, `vitest.config.ts`).
2. `types.ts`, `capabilities.ts`, `stream.ts`, `errors.ts`, `registry.ts`.
3. `create-agent.ts` factory wiring (no adapters yet — just the dispatch).

**Phase B — Claude SDK adapter** (~1.5 days)
4. `adapters/claude-sdk/index.ts` + `normalize.ts`.
5. Stream → chunk mapping. Tool-use turn surfacing.
6. Conformance suite v1 (echo, multi-turn, abort, usage assertion).

**Phase C — claude-code-cli adapter** (~2.5 days)
7. `adapters/shared/child-process.ts` (spawn, stdio, abort).
8. `adapters/claude-code-cli/{index,flags,stream-parser}.ts`.
9. Fixture-based tests (canned stdout transcripts) + at least one live integration test (manual; skipped in CI without binary).
10. Adapter passes the conformance suite.

**Phase D — opencode-cli adapter** (~1.5 days)
11. `adapters/opencode-cli/*` — mostly mirrors claude-code-cli.
12. Verify capability matrix TBDs against the live tool.
13. Adapter passes the conformance suite.

**Phase D' — Copilot adapters** (~2.5 days)
13a. `adapters/copilot-sdk/{index,normalize,headers,sse-parser}.ts` — HTTP POST, OpenAI-compatible request/response shapes, hardcoded Copilot contract headers, SSE streaming. Tool-use forwarding. (~1.5 days)
13b. `adapters/copilot-cli/*` — `gh copilot suggest` wrapper with `--target=shell|git|gh` switch; single-block stdout; sandbox `$HOME`/`$TMPDIR` to job workdir. (~0.5 days)
13c. Conformance suite extended with a "limited adapter" path; `copilot-sdk` passes full suite, `copilot-cli` passes the reduced subset (skip tool-use + multi-turn + streaming-incremental scenarios). (~0.5 days)

**Phase E — Auth integration + ergonomics** (~1 day)
14. `CredentialBroker` interface, optional auth-lib hookup.
15. `mountAgentCommand` for commander/yargs.
16. Documentation + first-consumer integration (per § 13 Q8).

**Phase F — Ship**
17. README quickstart, internal publish.

Estimated calendar time: **9–11 focused days for v1**, including the first-consumer integration and the two Copilot adapters added in Phase D'. Plan budget: 13 days.

## 15. Future Work (v2+)

- **Sessions** — `agent.session()` with `--continue` / `--resume` semantics (per D1).
- **`@your-org/agent-adapter-langchain` companion** — thin wrapper exposing `AgentAdapter` as a LangChain `Runnable` for the harness's LangGraph usage (per D4).
- **`agent.registerTool()` sugar** — adapter-side tool-loop helper for SDK adapter; host opts in (per D2).
- **OpenAI SDK adapter** — fills the SDK side of the parity story.
- **Bedrock / Vertex / OpenRouter / Cursor CLI adapters** — community contributions, validated against conformance suite.
- **Tool-loop helper** — `runToolLoop(agent, input, tools)` runs SDK-side multi-turn tool conversations end-to-end.
- **Shared transcript format** — captures from any adapter readable by any inspector tool.
- **Adapter middleware** — request/response interceptors (logging, redaction, rate-limit shaping) composable across adapters.
- **Adapter-to-adapter translation** — record claude-code session, replay against claude-sdk for testing.
- **Streaming-stream resilience** — reconnect / partial-replay on dropped subprocess.

## 16. Out-of-Scope Forever (intentional)

- **Replacing the underlying SDKs / CLIs.** When `@anthropic-ai/sdk` adds a feature, consumers wanting it use the SDK directly with `agent.config` to share the model spec. The lib does not chase upstream feature parity; it abstracts the *invocation contract* only.
- **Hosting agents.** No agent process management beyond the per-invocation subprocess. If you want a long-lived agent server, the harness is the right layer.
- **Prompt engineering.** The lib forwards messages; it does not transform, optimize, or template them.
- **Retries.** Hosts wrap with their own retry; the harness has built-in retry policies. Adding retry to the lib creates two competing behaviors.
- **Output validation.** The lib returns whatever the model said. Schema validation, JSON repair, structured output coercion — host's problem (or a sibling lib).

---

*End of agent-adapter PRD.*
