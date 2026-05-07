/**
 * CopilotChatAdapter — calls GitHub Copilot's chat-completions API.
 *
 * Per memory `project_per_worker_model_subscription`: github-copilot is
 * a meta-vendor (proxies to GPT-4o, Claude, Gemini under one auth/billing
 * boundary). Auth is fully wired in `@ecruz165/agent-auth` — device-
 * code login + session-token exchange + lazy refresh — what's been
 * missing is the chat-call adapter. This is it.
 *
 * Auth flow (handled internally; adapter just needs the auth.json path):
 *   1. Read GitHub OAuth token from AuthStore (`harness auth login
 *      github-copilot` populates it via device-code flow).
 *   2. Exchange for short-lived Copilot session-token via
 *      api.github.com/copilot_internal/v2/token (or use the AuthStore-
 *      cached token if still valid). Per `agent-auth-lib`'s
 *      getCopilotSessionToken — proactive 5-minute refresh threshold.
 *   3. POST messages to api.githubcopilot.com/chat/completions with the
 *      session token as Bearer auth + Copilot-Integration headers.
 *   4. On 401 (revocation / clock skew): clear the cached session token,
 *      re-exchange, retry once.
 *
 * Fetch injection: the adapter takes an optional `fetchFn` so tests can
 * stub all HTTP calls (token exchange + chat completion) without
 * touching the network. Production callers leave this unset and use the
 * platform's global fetch.
 *
 * Why not just call `callCopilot` from agent-auth-lib? Two reasons:
 *   1. agent-auth-lib's callCopilot uses global fetch — not injectable
 *      for unit tests. We re-implement the same flow here with the
 *      injection point.
 *   2. Adapter contract requires AdapterEvent emission (request/response/
 *      error), which agent-auth-lib's callCopilot doesn't do.
 */

import { AuthStore } from '@ecruz165/agent-auth';
import { classifyHttpError, classifyNetworkError } from './errors.ts';
import { AdapterEventBus, type TokenUsage } from './events.ts';
import type { AgentAdapter, InvocationSpec } from './types.ts';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface CopilotTokenResponse {
  token: string;
  expires_at: number;
}

const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
const COPILOT_CHAT_URL = 'https://api.githubcopilot.com/chat/completions';
const TOKEN_REFRESH_THRESHOLD_S = 5 * 60;

/** Headers Copilot's API expects from a chat client. Keep these in sync
 *  with VS Code's Copilot extension's User-Agent / version pattern;
 *  Copilot's server tightens enforcement periodically. */
const COPILOT_CLIENT_HEADERS: Record<string, string> = {
  'Editor-Version': 'vscode/1.95.0',
  'Editor-Plugin-Version': 'copilot-chat/0.20.0',
  'Copilot-Integration-Id': 'vscode-chat',
  'Openai-Intent': 'conversation-panel',
  'User-Agent': 'GitHubCopilotChat/0.20.0',
};

export interface CopilotChatAdapterOptions {
  /** Path to the auth.json file containing the GitHub OAuth token.
   *  Typically `~/.agentx/auth.json` populated via
   *  `harness auth login github-copilot`. */
  authPath: string;
  /** Copilot-routed model id. Default: 'gpt-4o'. Other valid values
   *  include 'claude-3-5-sonnet', 'gemini-1.5-pro' (Copilot's
   *  meta-vendor catalog — pick from `harness models` once that lands). */
  model?: string;
  /** Inject a fetch function. Default: global fetch. Tests stub both
   *  the token-exchange and chat-completion calls via this. */
  fetchFn?: typeof fetch;
}

export class CopilotChatAdapter implements AgentAdapter {
  readonly events = new AdapterEventBus();

  constructor(private readonly opts: CopilotChatAdapterOptions) {}

  async invoke(spec: InvocationSpec): Promise<string> {
    const fetchFn = this.opts.fetchFn ?? fetch;
    const model = this.opts.model ?? 'gpt-4o';
    const store = new AuthStore(this.opts.authPath);

    const file = await store.read();
    const cred = file.providers['github-copilot'];
    if (!cred?.apiKey || cred.apiKey.includes('REPLACE_ME')) {
      throw new Error('github-copilot not authenticated. Run: harness auth login github-copilot');
    }

    const messages: ChatMessage[] = [];
    if (spec.system) messages.push({ role: 'system', content: spec.system });
    messages.push({ role: 'user', content: spec.user });

    this.events.emit({
      kind: 'request',
      ts: new Date().toISOString(),
      system: spec.system,
      user: spec.user,
      model,
      provider: 'github-copilot',
    });

    try {
      const reply = await this.callWithRetry(fetchFn, store, cred.apiKey, messages, model);
      const usage = extractCopilotUsage(reply.raw);
      this.events.emit({
        kind: 'response',
        ts: new Date().toISOString(),
        text: reply.text,
        raw: reply.raw,
        ...(usage ? { usage } : {}),
      });
      return reply.text;
    } catch (err) {
      // callWithRetry already throws classified errors (AdapterError
      // subclasses); pass-through here. Pre-network/auth-store errors
      // (the classifier doesn't see those) get classified as
      // NetworkError as the safe default — they're rarely seen in
      // practice but covered for completeness.
      const classified =
        err instanceof Error &&
        err.name.endsWith('Error') &&
        [
          'AuthError',
          'BillingError',
          'RateLimitError',
          'ConfigError',
          'NetworkError',
          'ProviderError',
          'AdapterError',
        ].includes(err.name)
          ? err
          : classifyNetworkError(err, 'github-copilot');
      this.events.emit({
        kind: 'error',
        ts: new Date().toISOString(),
        message: classified.message,
        cause: classified,
      });
      throw classified;
    }
  }

  private async callWithRetry(
    fetchFn: typeof fetch,
    store: AuthStore,
    githubToken: string,
    messages: ChatMessage[],
    model: string,
  ): Promise<{ text: string; raw: ChatCompletionResponse }> {
    let token = await this.getSessionToken(fetchFn, store, githubToken);
    let res = await this.postChat(fetchFn, token, messages, model);

    // Single retry on 401 — typical cause is server-side revocation or
    // local-vs-server clock skew making our cached token spuriously valid.
    // Clear cache, re-exchange, retry once. If the second attempt also
    // 401s, it's a real auth problem; surface the error.
    if (res.status === 401) {
      await this.invalidateCachedSessionToken(store);
      token = await this.getSessionToken(fetchFn, store, githubToken);
      res = await this.postChat(fetchFn, token, messages, model);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw classifyHttpError({
        status: res.status,
        body,
        retryAfter: res.headers.get('retry-after'),
        context: 'github-copilot',
      });
    }

    const raw = (await res.json()) as ChatCompletionResponse;
    const text = raw.choices?.[0]?.message?.content ?? '';
    return { text, raw };
  }

  /** Get a Copilot session token, using the cached one if it has more
   *  than 5 minutes left. Otherwise exchange the GitHub OAuth token. */
  private async getSessionToken(
    fetchFn: typeof fetch,
    store: AuthStore,
    githubToken: string,
  ): Promise<string> {
    const file = await store.read();
    const existing = file.providers['github-copilot'];
    if (existing?.copilotToken && existing.copilotTokenExpiresAt) {
      const remaining = existing.copilotTokenExpiresAt - Math.floor(Date.now() / 1000);
      if (remaining > TOKEN_REFRESH_THRESHOLD_S) return existing.copilotToken;
    }
    const res = await fetchFn(COPILOT_TOKEN_URL, {
      headers: { Authorization: `token ${githubToken}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `Copilot session-token exchange failed (${res.status}): ${body.slice(0, 300)}`,
      );
    }
    const data = (await res.json()) as CopilotTokenResponse;
    await store.setProvider('github-copilot', {
      ...(existing ?? { apiKey: githubToken }),
      apiKey: githubToken,
      copilotToken: data.token,
      copilotTokenExpiresAt: data.expires_at,
    });
    return data.token;
  }

  private async invalidateCachedSessionToken(store: AuthStore): Promise<void> {
    const file = await store.read();
    const entry = file.providers['github-copilot'];
    if (entry) {
      entry.copilotToken = undefined;
      entry.copilotTokenExpiresAt = undefined;
      await store.write(file);
    }
  }

  private async postChat(
    fetchFn: typeof fetch,
    sessionToken: string,
    messages: ChatMessage[],
    model: string,
  ): Promise<Response> {
    return fetchFn(COPILOT_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        'Content-Type': 'application/json',
        ...COPILOT_CLIENT_HEADERS,
      },
      body: JSON.stringify({ model, messages, stream: false }),
    });
  }
}

function extractCopilotUsage(raw: ChatCompletionResponse): TokenUsage | undefined {
  const u = raw.usage;
  if (!u) return undefined;
  const out: TokenUsage = {};
  if (u.prompt_tokens !== undefined) out.promptTokens = u.prompt_tokens;
  if (u.completion_tokens !== undefined) out.completionTokens = u.completion_tokens;
  if (u.total_tokens !== undefined) out.totalTokens = u.total_tokens;
  return Object.keys(out).length > 0 ? out : undefined;
}
