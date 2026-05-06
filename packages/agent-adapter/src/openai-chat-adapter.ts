/**
 * OpenAiChatAdapter — direct OpenAI API call.
 *
 * Per memory `project_per_worker_model_subscription`: the original
 * design routed openai bindings through OpenCodeCliAdapter. Reality
 * check: opencode 1.4's built-in openai provider has a curated model
 * catalog (gpt-5-codex, gpt-5.x, etc.) that doesn't include
 * gpt-4o / gpt-4o-mini and adds its own auth/billing requirements
 * (some of opencode's openai paths require a ChatGPT account, not just
 * an API key). For direct OpenAI access — give us your API key, give
 * us a model id, hit the API — opencode is the wrong layer.
 *
 * This adapter is the right one for that case: thin fetch-based client
 * pointed at api.openai.com/v1/chat/completions. Mirrors
 * CopilotChatAdapter's shape: takes a CredentialBroker (for the API
 * key), an injectable fetchFn (for tests), and the standard adapter
 * event surface.
 *
 * For richer use cases (tools, structured output, streaming), this
 * adapter is the floor — adapter layers above (LangGraph, opencode,
 * etc.) build on top. v1 supports plain chat completions only.
 */

import type { CredentialBroker } from '@agentx/agent-auth-lib';
import { classifyHttpError, classifyNetworkError } from './errors.ts';
import { AdapterEventBus, type TokenUsage } from './events.ts';
import type { AgentAdapter, InvocationSpec } from './types.ts';

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';

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

export interface OpenAiChatAdapterOptions {
  /** Credential broker the adapter calls to get the API key. Typically
   *  a FileBroker pointed at ~/.agentx/auth.json. */
  broker: CredentialBroker;
  /** Model id, e.g. 'gpt-4o', 'gpt-4o-mini'. The adapter passes this
   *  through to the OpenAI API verbatim — pick a model id your API key
   *  has access to. */
  model?: string;
  /** Optional override of the API endpoint. Default:
   *  https://api.openai.com/v1/chat/completions. Useful for tests
   *  (point at a local mock) and for OpenAI-compatible third-party
   *  endpoints (Azure OpenAI, OpenRouter, etc.). */
  endpoint?: string;
  /** Inject a fetch function. Default: global fetch. Tests stub this. */
  fetchFn?: typeof fetch;
}

export class OpenAiChatAdapter implements AgentAdapter {
  readonly events = new AdapterEventBus();

  constructor(private readonly opts: OpenAiChatAdapterOptions) {}

  async invoke(spec: InvocationSpec): Promise<string> {
    const fetchFn = this.opts.fetchFn ?? fetch;
    const model = this.opts.model ?? 'gpt-4o';
    const url = this.opts.endpoint ?? OPENAI_CHAT_URL;

    const cred = await this.opts.broker.getCredential('openai');

    const messages: ChatMessage[] = [];
    if (spec.system) messages.push({ role: 'system', content: spec.system });
    messages.push({ role: 'user', content: spec.user });

    this.events.emit({
      kind: 'request',
      ts: new Date().toISOString(),
      system: spec.system,
      user: spec.user,
      model,
      provider: 'openai',
    });

    let res: Response;
    try {
      res = await fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cred.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, messages, stream: false }),
      });
    } catch (err) {
      // Pre-response failure (DNS, TCP, TLS, abort) → NetworkError.
      const classified = classifyNetworkError(err, 'openai');
      this.events.emit({
        kind: 'error',
        ts: new Date().toISOString(),
        message: classified.message,
        cause: classified,
      });
      throw classified;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // HTTP-level failure → classify by status + body fingerprint.
      const classified = classifyHttpError({
        status: res.status,
        body,
        retryAfter: res.headers.get('retry-after'),
        context: 'openai',
      });
      this.events.emit({
        kind: 'error',
        ts: new Date().toISOString(),
        message: classified.message,
        cause: classified,
      });
      throw classified;
    }

    const raw = (await res.json()) as ChatCompletionResponse;
    const text = raw.choices?.[0]?.message?.content ?? '';
    const usage = extractOpenAiUsage(raw);

    this.events.emit({
      kind: 'response',
      ts: new Date().toISOString(),
      text,
      raw,
      ...(usage ? { usage } : {}),
    });
    return text;
  }
}

function extractOpenAiUsage(raw: ChatCompletionResponse): TokenUsage | undefined {
  const u = raw.usage;
  if (!u) return undefined;
  const out: TokenUsage = {};
  if (u.prompt_tokens !== undefined) out.promptTokens = u.prompt_tokens;
  if (u.completion_tokens !== undefined) out.completionTokens = u.completion_tokens;
  if (u.total_tokens !== undefined) out.totalTokens = u.total_tokens;
  return Object.keys(out).length > 0 ? out : undefined;
}
