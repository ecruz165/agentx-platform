import Anthropic from '@anthropic-ai/sdk';
import type { CredentialBroker } from '@agentx/agent-auth-lib';
import { AdapterEventBus } from './events.ts';
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

      this.events.emit({
        kind: 'response',
        ts: new Date().toISOString(),
        text,
        raw: resp,
      });

      return text;
    } catch (err) {
      this.events.emit({
        kind: 'error',
        ts: new Date().toISOString(),
        message: (err as Error).message,
        cause: err,
      });
      throw err;
    }
  }
}
