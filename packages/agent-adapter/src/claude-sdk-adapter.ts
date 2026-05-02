import Anthropic from '@anthropic-ai/sdk';
import type { CredentialBroker } from '@agentx/auth-lib';
import type { AgentAdapter, CaptureSink } from './types.ts';

export interface ClaudeSdkAdapterOptions {
  broker: CredentialBroker;
  capture: CaptureSink;
  model?: string;
}

export class ClaudeSdkAdapter implements AgentAdapter {
  constructor(private readonly opts: ClaudeSdkAdapterOptions) {}

  async invoke(prompt: string): Promise<string> {
    const cred = await this.opts.broker.getCredential('anthropic');
    const client = new Anthropic({ apiKey: cred.apiKey });

    const request = {
      model: this.opts.model ?? 'claude-opus-4-7',
      max_tokens: 256,
      messages: [{ role: 'user' as const, content: prompt }],
    };

    await this.opts.capture.write({
      ts: new Date().toISOString(),
      kind: 'request',
      payload: { ...request, _credentialSource: cred.source },
    });

    try {
      const resp = await client.messages.create(request);
      await this.opts.capture.write({
        ts: new Date().toISOString(),
        kind: 'response',
        payload: resp,
      });
      const block = resp.content[0];
      return block?.type === 'text' ? block.text : '';
    } catch (err) {
      await this.opts.capture.write({
        ts: new Date().toISOString(),
        kind: 'error',
        payload: { message: (err as Error).message },
      });
      throw err;
    }
  }
}
