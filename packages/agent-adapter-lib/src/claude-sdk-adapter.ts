import type { CredentialBroker } from '@agentx/agent-auth';
import Anthropic, { APIError as AnthropicAPIError } from '@anthropic-ai/sdk';
import { type AdapterError, classifyHttpError, classifyNetworkError } from './errors.ts';
import { AdapterEventBus, type TokenUsage } from './events.ts';
import type { AgentAdapter, InvocationSpec } from './types.ts';

export interface ClaudeSdkAdapterOptions {
  broker: CredentialBroker;
  model?: string;
}

export class ClaudeSdkAdapter implements AgentAdapter {
  readonly events = new AdapterEventBus();

  constructor(private readonly opts: ClaudeSdkAdapterOptions) {}

  async invoke(spec: InvocationSpec): Promise<string> {
    const cred = await this.opts.broker.getCredential('anthropic');
    const client = new Anthropic({ apiKey: cred.apiKey });
    const model = this.opts.model ?? 'claude-opus-4-7';

    this.events.emit({
      kind: 'request',
      ts: new Date().toISOString(),
      system: spec.system,
      user: spec.user,
      model,
      provider: 'anthropic',
    });

    try {
      const resp = await client.messages.create({
        model,
        max_tokens: 256,
        ...(spec.system ? { system: spec.system } : {}),
        messages: [{ role: 'user', content: spec.user }],
      });
      const block = resp.content[0];
      const text = block?.type === 'text' ? block.text : '';

      // Anthropic's SDK reports input_tokens / output_tokens separately
      // — normalize to our TokenUsage shape (prompt = input,
      // completion = output, total = sum). Cache-read/creation tokens
      // exist on some responses but aren't surfaced here in v1.
      const usage = extractAnthropicUsage(resp);

      this.events.emit({
        kind: 'response',
        ts: new Date().toISOString(),
        text,
        raw: resp,
        ...(usage ? { usage } : {}),
      });

      return text;
    } catch (err) {
      // Classify into typed AdapterError subclasses so consumers can
      // discriminate AuthError / BillingError / RateLimitError /
      // ConfigError / ProviderError. Per slice 13b error hierarchy.
      const classified = classifyAnthropicError(err);
      this.events.emit({
        kind: 'error',
        ts: new Date().toISOString(),
        message: classified.message,
        cause: classified,
      });
      throw classified;
    }
  }
}

function extractAnthropicUsage(resp: Anthropic.Message): TokenUsage | undefined {
  const u = resp.usage as { input_tokens?: number; output_tokens?: number } | undefined;
  if (!u) return undefined;
  const promptTokens = u.input_tokens;
  const completionTokens = u.output_tokens;
  const totalTokens =
    promptTokens !== undefined && completionTokens !== undefined
      ? promptTokens + completionTokens
      : undefined;
  if (promptTokens === undefined && completionTokens === undefined) return undefined;
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

function classifyAnthropicError(err: unknown): AdapterError {
  // The SDK throws subclasses of APIError for HTTP-level failures with
  // a `status` and a stringified body. Use the shared classifier.
  if (err instanceof AnthropicAPIError) {
    const retryAfter =
      typeof err.headers === 'object' && err.headers !== null
        ? (err.headers as Record<string, string>)['retry-after']
        : undefined;
    const body = (() => {
      try {
        return typeof err.error === 'string' ? err.error : JSON.stringify(err.error ?? {});
      } catch {
        return '';
      }
    })();
    return classifyHttpError({
      status: err.status ?? 0,
      body: `${err.message} ${body}`,
      retryAfter,
      cause: err,
      context: 'anthropic',
    });
  }
  return classifyNetworkError(err, 'anthropic');
}
