# auth-lib — Implementation PRD

**Status:** Draft (2026-04-30)
**Owner:** Edwin Cruz
**Audience:** future implementer (human or agent) picking this up cold
**Reference impl:** `/Users/edwincruz/Development/Workspaces/ecruz165/<reference-cli>/src/auth/`

---

## 1. Purpose

A standalone, app-agnostic TypeScript library that handles AI-provider authentication and API calling for any Node CLI tool that needs to talk to Claude/Anthropic, GitHub Copilot, or OpenAI.

The library extracts and generalizes the auth subsystem already proven in `<reference-cli>`. By centralizing this concern:

1. Every CLI in the ecosystem (mtauth-installer-cli, future tools) gets OAuth login + API key support for free.
2. Users log in **once** to a shared `~/.<your-org>/auth.json` and every CLI in the ecosystem picks up the credential.
3. New providers (Bedrock, OpenRouter, etc.) are added in one place and benefit every consumer.
4. Provider quirks (Anthropic OAuth tokens needing `?beta=true`, Copilot needing editor-spoof headers) are hidden inside the lib.

**Why now:** Auth concerns recur in every CLI that talks to AI providers, and the reference implementation already exists in a sibling repo. Extracting the lib early — before multiple CLIs each reinvent the same OAuth + token-storage code — is cheap. Waiting until five tools have copy-pasted divergent versions is expensive.

## 2. Goals (v1)

- **Pluggable provider model**: a single `AIProvider` interface; built-in implementations for `anthropic`, `copilot`, `openai`. Consumers can register custom providers without modifying the lib.
- **Two flows per provider where applicable**:
  - **API key** via env var (e.g., `ANTHROPIC_API_KEY`)
  - **OAuth login** with browser-driven flow + token storage + auto-refresh
- **Unified credential storage**: a single multi-provider `~/.<your-org>/auth.json` shared across all consumers. Override path supported.
- **Unified API call dispatcher**: `callAI(messages, model, providerName?)` routes to the right provider, handles auth, retries on 401, surfaces token usage.
- **Mountable CLI sub-commands**: helper functions consumers wrap as their own CLI (`<bin> auth login`, `auth status`, `auth logout`, `auth use <provider>`).
- **Zero hardcoded app-identity**: home dir path, user-agent, CLI bin name, telemetry sink — all injected at construction time.
- **Backward-compatible auth file format**: auto-migrates legacy formats (the <reference-cli> legacy flat-format migration logic is preserved and generalized).

## 3. Non-Goals (v1)

- **Not a credential vault.** Storage is plaintext JSON in user home dir (matching existing reference). OS-keychain integration deferred to v2.
- **Not a full SDK wrapper.** Lib calls provider HTTP endpoints directly (matching reference) — does not import `@anthropic-ai/sdk`, `openai`, etc. Consumers wanting SDK ergonomics can use the lib for credentials only and instantiate their own SDK.
- **Not a quota / billing tracker.** `callAI` emits a token-usage event; consumers wire that to their own billing/observability.
- **Not OAuth-as-a-service.** Each provider has its own client ID configured in the lib. The lib does not run its own auth proxy.
- **Not a streaming-first library.** v1 is non-streaming `callAI(...)` only. Streaming deferred.
- **Not an MCP client.** Out of scope.
- **Not a tool-use orchestrator.** That's the agentic-harness's job. This lib is one layer below: just credentials + a single `messages` call.

## 4. Reference & Provenance

The lib begins as a **straight extraction** of `<reference-cli>/src/auth/`. The reference includes:

| File | Purpose | Reuse? |
|---|---|---|
| `types.ts` | Zod schemas + interfaces (AuthFile, OAuthCredentials, etc.) | Reuse, generalize app-identity constants |
| `provider.ts` | `AIProvider` interface, `AIProviderName` enum | Reuse as-is |
| `provider-registry.ts` | Singleton provider registry | Reuse + add `registerProvider()` for extensions |
| `token-manager.ts` | `auth.json` read/write/migrate, Copilot token fetch, `callCopilot` | Split: extract Copilot-specific logic into providers/copilot.ts |
| `device-flow.ts` | GitHub OAuth Device Flow | Reuse + parameterize CLI bin name |
| `oauth-pkce.ts` | PKCE helpers + localhost callback server | Reuse as-is |
| `call-ai.ts` | Unified dispatcher with telemetry logging | Reuse + replace `getHomePath()` with config |
| `providers/anthropic.ts` | Anthropic provider (PKCE copy-paste flow) | Reuse + parameterize `originator` |
| `providers/copilot.ts` | GitHub Copilot provider (Device Flow) | Reuse + parameterize editor headers |
| `providers/openai.ts` | OpenAI provider | Reuse |
| `index.ts` | Public exports | Rewrite as cleaner public API |

**Hardcoded values to extract:**
- `EDITOR_VERSION = '<your-org-CLI>/0.1.0'` → consumer-supplied user agent
- `getHomePath()` import → consumer-supplied home dir factory
- `CLI_BIN_NAME` import → consumer-supplied CLI name (used in error messages)
- Copilot's `'GithubCopilot/1.155.0'` user-agent / `'copilot.vim/1.16.0'` plugin version → kept constant (these are Copilot API contract requirements, not app-identity)
- `~/.<reference-cli>/auth.json` → defaults to `~/.<your-org>/auth.json`, override supported

## 5. Package Layout

| | |
|---|---|
| Path | `npm-dependency/auth-lib/` |
| Package name | `@your-org/auth-lib` |
| Lang | TypeScript, Node ≥20, ESM |
| Test runner | `vitest` |
| Runtime deps | `zod`, `chalk` (optional — see §13 Q5) |

```
auth-lib/
├── src/
│   ├── index.ts                    # public exports
│   ├── auth-client.ts              # createAuthClient(config) factory; main entry point
│   ├── config.ts                   # AuthClientConfig type + defaults
│   ├── types.ts                    # zod schemas + interface types
│   ├── auth-file.ts                # read/write ~/.<your-org>/auth.json + legacy migration
│   ├── provider.ts                 # AIProvider interface, AIProviderName
│   ├── provider-registry.ts        # built-in registry + custom registration
│   ├── call-ai.ts                  # callAI dispatcher
│   ├── flows/
│   │   ├── oauth-pkce.ts           # PKCE helpers + localhost callback server
│   │   └── device-flow.ts          # GitHub-style device flow
│   ├── providers/
│   │   ├── anthropic.ts            # PKCE copy-paste flow
│   │   ├── copilot.ts              # Device flow + editor headers
│   │   └── openai.ts
│   ├── telemetry/
│   │   ├── usage-event.ts          # TokenUsageEvent type
│   │   └── jsonl-sink.ts           # optional JSONL telemetry sink
│   └── errors.ts                   # AuthLibError taxonomy
├── test/
├── package.json
├── tsconfig.json
└── .plans/
    └── 2026-04-30-auth-lib-prd.md   # this file
```

## 6. Public API

The library exposes a single factory + a few helper utilities. Consumers build an `AuthClient` once at startup and pass it around:

```ts
import { createAuthClient } from '@your-org/auth-lib';

const auth = createAuthClient({
  appName: 'my-cli',                      // used in error messages
  userAgent: '@jefelabs/my-cli/0.1.0',    // sent on outbound HTTP calls
  authFilePath: undefined,                   // defaults to ~/.<your-org>/auth.json
  telemetrySink: undefined,                  // optional usage logging
});

// Auth operations
await auth.login('anthropic');                       // run OAuth flow (or use API key env var)
const status = await auth.resolveAuth('anthropic');  // { source: 'env:ANTHROPIC_API_KEY' } | null
await auth.logout('anthropic');
await auth.useProvider('anthropic');                  // set active provider in auth.json

// AI operations
const response = await auth.callAI(messages, 'claude-sonnet-4-20250514', 'anthropic');
const models = await auth.listModels('anthropic');

// Lower-level: just get a credential, instantiate your own SDK
const cred = await auth.getCredential('anthropic');
// cred = { apiKey: '...', source: 'env' | 'oauth' | 'api-key', expiresAt?: Date }
```

### `AuthClient` interface (full)

```ts
interface AuthClient {
  // Provider lifecycle
  login(provider: AIProviderName, opts?: LoginOptions): Promise<{ displayName: string }>;
  logout(provider: AIProviderName): Promise<void>;
  resolveAuth(provider?: AIProviderName): Promise<AuthSource | null>;
  isAuthenticated(provider?: AIProviderName): Promise<boolean>;
  useProvider(provider: AIProviderName): Promise<void>;
  getActiveProvider(): Promise<AIProviderName>;

  // AI calls
  callAI(messages: ChatCompletionMessage[], model: string, provider?: AIProviderName, caller?: string): Promise<ChatCompletionResponse>;
  listModels(provider?: AIProviderName): Promise<AIModelEntry[] | null>;

  // Credential access (for consumers using their own SDK)
  getCredential(provider: AIProviderName): Promise<CredentialResult>;

  // Provider extension
  registerProvider(provider: AIProvider): void;
}

interface CredentialResult {
  apiKey: string;
  source: 'env' | 'oauth' | 'api-key-stored';
  expiresAt?: Date;
}
```

### Mountable CLI helpers

For consumers wanting standard sub-commands, the lib exports ready-made commander/yargs-compatible handlers:

```ts
import { mountAuthCommands } from '@your-org/auth-lib/cli';
import { Command } from 'commander';

const program = new Command();
mountAuthCommands(program, auth);   // adds `auth login`, `auth logout`, `auth status`, `auth use`
```

Result: every consumer CLI gets an identical `<bin> auth login` UX with one line of code.

## 7. Core Types & Schemas

Zod schemas (extracted from reference; generalized name):

```ts
// Per-provider OAuth credentials (Anthropic, OpenAI)
export const OAuthCredentialsSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  token_expires_at: z.number().optional(),    // epoch seconds
  display_name: z.string().optional(),
});

// Copilot-specific (GitHub OAuth → Copilot token exchange)
export const CopilotCredentialsSchema = z.object({
  github_token: z.string(),
  copilot_token: z.string().optional(),
  copilot_token_expires_at: z.number().optional(),
  username: z.string().optional(),
});

// The full auth file
export const AuthFileSchema = z.object({
  active_provider: z.enum(['copilot', 'anthropic', 'openai']).default('copilot'),
  copilot: CopilotCredentialsSchema.optional(),
  anthropic: OAuthCredentialsSchema.optional(),
  openai: OAuthCredentialsSchema.optional(),
});
```

Custom providers add their slot at registration time (zod schema merge — see §13 Q1 for the design choice).

## 8. AIProvider Interface

Direct port of the reference's `AIProvider` (no changes; the design is sound):

```ts
export interface AIProvider {
  readonly name: AIProviderName;

  /** Run the OAuth/login flow. Returns display name on success. */
  login(opts?: { force?: boolean }): Promise<{ displayName: string }>;

  /** Check if valid credentials exist. Returns source info or null. */
  resolveAuth(): Promise<{ source: string } | null>;

  /** Send a chat completion request. */
  callAI(messages: ChatCompletionMessage[], model: string): Promise<ChatCompletionResponse>;

  /** List available models. Returns null if API call fails. */
  listModels(): Promise<AIModelEntry[] | null>;

  /** Revoke / delete stored credentials. */
  logout(): Promise<void>;
}
```

Built-in implementations: `AnthropicProvider`, `CopilotProvider`, `OpenAIProvider`. Each constructed with the lib's config (gets userAgent, appName, authFilePath via dependency injection).

## 9. Auth File Format & Storage

**Location (default):** `~/.<your-org>/auth.json`

**Override:** consumer passes `authFilePath` to `createAuthClient`. Per-app isolation if needed.

**Format:**
```json
{
  "active_provider": "anthropic",
  "anthropic": {
    "access_token": "sk-ant-oat-...",
    "refresh_token": "...",
    "token_expires_at": 1735689600,
    "display_name": "Claude User"
  },
  "copilot": {
    "github_token": "gho_...",
    "copilot_token": "...",
    "copilot_token_expires_at": 1735689600,
    "username": "edwincruz"
  }
}
```

**Permissions:** file written with mode `0600` (owner read/write only). Directory created with `0700`.

**Legacy migration:** detects old flat format (`{ github_token, copilot_token, ... }`) and migrates inline to the multi-provider format on first read. Code already exists in reference's `readAuthFile()`.

**Concurrency:** single-process atomic writes (write to `auth.json.tmp`, fsync, rename). No multi-process locking — login is interactive and rare.

## 10. Credential Resolution Precedence

Per provider, the resolver tries sources in order until one yields a credential:

### Anthropic
1. `ANTHROPIC_API_KEY` env var → returned as `{ apiKey, source: 'env' }`
2. `auth.json` → `anthropic.access_token` (auto-refresh via `refresh_token` if `token_expires_at < now`)
3. None → `null`

### Copilot
1. `COPILOT_GITHUB_TOKEN` env var
2. `GITHUB_TOKEN` env var
3. `auth.json` → `copilot.github_token`
4. None → `null`

After GitHub token resolution, lib exchanges it for a Copilot API token (`https://api.github.com/copilot_internal/v2/token`), caches result with `expires_at`, refreshes proactively at 5-minute remaining threshold (existing logic).

### OpenAI
1. `OPENAI_API_KEY` env var
2. `auth.json` → `openai.access_token` (with refresh if applicable)
3. None → `null`

**Important nuance**: Anthropic OAuth-derived tokens (`sk-ant-oat...`) require different request headers than direct API keys. The lib branches internally based on token prefix — consumers never need to care which auth method produced their working credential.

## 11. OAuth Flow Patterns

The lib supports three flow patterns; each provider picks the one its OAuth server requires.

### 11.1 Device Flow (GitHub Copilot)

Standard OAuth 2.0 Device Authorization Grant (RFC 8628). User visits a URL, enters a code, lib polls for the token. No localhost server, no browser callback.

```
1. POST /login/device/code    → { user_code, verification_uri, device_code, interval }
2. CLI prints user_code to terminal, opens browser to verification_uri
3. CLI polls /login/oauth/access_token every `interval` seconds
4. On success, store github_token in auth.json
5. Exchange github_token → copilot_token via /copilot_internal/v2/token
```

Code already in reference `device-flow.ts`. Reused as-is, with CLI bin name parameterized for the prompts.

### 11.2 PKCE + Localhost Callback (generic)

Standard OAuth 2.0 with PKCE, redirect to a temporary `http://localhost:<port>/auth/callback`. Lib starts an HTTP server, opens the browser, captures the code from the redirect.

Code already in reference `oauth-pkce.ts` (`waitForCallback`). Reused as-is.

This is the *preferred* flow for new providers. It's seamless — user clicks "Authorize" and is automatically returned to the CLI.

### 11.3 PKCE + Copy-Paste (Anthropic)

Anthropic's OAuth client is configured with a server-side redirect URI (`console.anthropic.com/oauth/code/callback`) that displays the code in `{code}#{state}` format. The CLI cannot capture it via localhost; user must copy-paste.

Code already in reference `providers/anthropic.ts`. Reused as-is.

`★ Why this is a separate pattern:` Anthropic's OAuth client doesn't allow a localhost redirect URI. We can't change that — it's their server-side config. So our flow is: open browser → user authorizes → user copies code from page → user pastes into terminal → lib exchanges for token. Less seamless but works without server-side cooperation.

## 12. Per-Provider Notes

### 12.1 Anthropic

- Client ID: `9d1c250a-e61b-44d9-88ed-5944d1962f5e` (Claude Code's published client ID)
- Auth URL: `https://claude.ai/oauth/authorize`
- Token URL: `https://console.anthropic.com/v1/oauth/token`
- Scopes: `org:create_api_key user:profile user:inference`
- API URL: `https://api.anthropic.com/v1/messages`
- **Critical**: OAuth tokens (`sk-ant-oat...`) need:
  - `Authorization: Bearer <token>` (not `x-api-key`)
  - `User-Agent: claude-cli/2.1.7 (external, cli)` (Claude Code-compatible)
  - `x-app: cli`
  - `anthropic-dangerous-direct-browser-access: true`
  - `anthropic-beta: oauth-2025-04-20,interleaved-thinking-2025-05-14,output-128k-2025-02-19`
  - `?beta=true` query param on the messages endpoint
- API keys (`sk-ant-...`): standard `x-api-key` header, no special params

### 12.2 GitHub Copilot

- Client ID: `Iv1.b507a08c87ecfe98` (overridable via `GITHUB_COPILOT_CLIENT_ID` env)
- Device code URL: `https://github.com/login/device/code`
- Token URL: `https://github.com/login/oauth/access_token`
- Copilot token exchange: `https://api.github.com/copilot_internal/v2/token`
- Chat URL: `https://api.githubcopilot.com/chat/completions`
- **Critical headers** (Copilot API contract — DO NOT parameterize these):
  - `User-Agent: GithubCopilot/1.155.0`
  - `Editor-Version: <userAgent from config>`
  - `Editor-Plugin-Version: copilot.vim/1.16.0`
  - `Copilot-Integration-Id: vscode-chat`
  - `Openai-Intent: conversation-panel`

### 12.3 OpenAI

Standard OAuth + API key. (Reference impl exists; review when extracting.)

## 13. Open Decisions

1. **Custom-provider extension model**: How does a consumer add a `bedrock` provider?
   - (a) Subclass `AIProvider`, call `auth.registerProvider(new BedrockProvider())` — runtime registration, no schema change
   - (b) Compile-time generic on `createAuthClient<E extends ExtraProviders>` — type-safe but verbose
   - **Lean: (a)**. Type-safety is nice but the cost is high; runtime registration matches how the agentic-harness uses factories.

2. **`~/.<your-org>/auth.json` vs. workspace-local**: Should auth state live in user home or be workspace-scoped?
   - **Lean: user home by default**, workspace override available via `authFilePath`. Most users want one login per machine.

3. **Active provider semantics**: When `callAI` is called without `providerName`, use `auth.json`'s `active_provider`. But what if the active provider isn't authenticated?
   - **Lean: fall through to first authenticated provider**, log a warning. Less error-y than rejecting outright.

4. **Telemetry sink**: Reference logs to `getHomePath()/ai-usage.jsonl`. Generalize to:
   - (a) Optional `telemetrySink` callback in config (consumer wires their own logger)
   - (b) Default to `~/.<your-org>/ai-usage.jsonl`
   - (c) Both — emit a callback if configured, else write to default file
   - **Lean: (a) only**. Built-in default file logging blurs the lib's responsibility. Consumers who want it can use `JsonlSink` from `@your-org/auth-lib/telemetry`.

5. **`chalk` dependency**: Reference uses chalk for colored login output. Should the lib?
   - (a) Yes — login UX is part of the value
   - (b) No — make output injectable so consumers can theme/silence
   - **Lean: (b) with built-in default**. Lib uses chalk by default; consumer can pass `outputAdapter: (msg) => ...` to override.

6. **Refresh-token failure handling**: When auto-refresh fails (token revoked, network error), what does `getCredential` do?
   - (a) Throw `AuthRefreshError`, force re-login
   - (b) Fall back to expired token (let the API call fail with 401)
   - (c) Try silent re-auth (impossible for OAuth without user)
   - **Lean: (a)**. Loud failure with a clear "run `<bin> auth login`" message beats a confusing 401 from upstream.

7. **Streaming support**: Reference is non-streaming. Add streaming to v1?
   - **Lean: defer to v1.1**. Most current consumers don't stream. Add when first streaming consumer appears.

8. **Workspace registration**: where does the package live in the monorepo? Or does it live in its own workspace?
   - Options: (a) `npm-dependency/auth-lib/` in jefelabs-com, (b) standalone `auth-lib/` workspace, (c) live in `<reference-cli>`'s monorepo
   - **Lean: (a)** initially, since that's where the first new consumer lives. Promote to (b) when it has 3+ consumers across workspaces.

## 14. Implementation Phases

**Phase A — Extraction** (~2 days)
1. Package skeleton (`package.json`, `tsconfig.json`, `vitest.config.ts`).
2. Copy reference's `types.ts`, `provider.ts`, `oauth-pkce.ts`, `device-flow.ts` into the new package; remove `getHomePath`/`CLI_BIN_NAME` imports, parameterize via config.
3. Copy reference's three providers; parameterize user-agent and CLI bin name.
4. Copy `token-manager.ts` → split into `auth-file.ts` (file ops, generic) and `providers/copilot.ts` (Copilot-specific token-exchange logic).
5. Copy `call-ai.ts` → `call-ai.ts`, replace `getHomePath()` with optional `telemetrySink` callback.

**Phase B — Public API** (~1 day)
6. Implement `auth-client.ts`: `createAuthClient(config)` factory wraps the registry, file ops, and dispatcher behind one `AuthClient` interface.
7. `mountAuthCommands(program, authClient)` for commander integration.
8. `index.ts` — public exports cleaned up.

**Phase C — Tests & validation** (~1 day)
9. Unit tests against mocked provider HTTP.
10. Integration test: real OAuth login with a test account (manual; skipped in CI).
11. Round-trip migration test: legacy auth.json → multi-provider format.

**Phase D — First consumer** (~0.5 day)
12. Wire `<reference-cli>` to consume `@your-org/auth-lib` (delete its local `src/auth/` once parity verified).

**Phase E — Ship**
13. README with quickstart, publish (workspace-internal initially).

Estimated calendar time: 4–5 focused days for v1, including the <reference-cli> cutover.

## 15. Future Work (v2+)

- **OS keychain storage**: `keytar` integration so credentials don't sit in plaintext JSON.
- **Streaming `callAI`**: AsyncIterable for stream consumers.
- **Token-bucket rate limiting** built into `callAI`, configurable per provider.
- **Audit log** of auth events (login, logout, token refresh, calls) signed with consumer-supplied key.
- **More providers**: Bedrock, Azure OpenAI, OpenRouter, Mistral, Groq.
- **MFA / SSO support** for enterprise OAuth (SAML, custom IdP redirects).
- **Per-workspace credential isolation by default**: with shared opt-in, instead of the reverse.
- **Headless OAuth flow**: refresh token-only re-auth without browser, for CI/automation.
- **Cost estimation**: lib emits estimated USD cost per call given a provided price table.

## 16. Out-of-Scope Forever (intentional)

- **Storing user credentials on a server.** This is a client-side library. No phone-home.
- **Analytics on what users do with credentials.** Telemetry is opt-in and never leaves the user's machine.
- **Provider-side OAuth client management.** The lib uses published client IDs (Claude Code's, Copilot's). Provisioning your own OAuth app for a fork is out of scope.
- **Replacing the upstream SDKs.** If `@anthropic-ai/sdk` adds a feature, consumers use the SDK with `getCredential()`. The lib does not chase SDK feature parity.
