import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CredentialBroker, Provider } from '@agentx/agent-auth-lib';
import { AdapterEventBus } from './events.ts';
import type { AgentAdapter, InvocationSpec } from './types.ts';

export interface OpenCodeCliAdapterOptions {
  broker: CredentialBroker;
  bin?: string;
  model?: string;
  provider?: Provider;
  timeoutMs?: number;
}

const PROVIDER_ENV_VAR: Partial<Record<Provider, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  // github-copilot is intentionally absent: OpenCode CLI doesn't natively
  // route through Copilot's API. v1.x may add a dedicated CopilotAdapter.
};

export class OpenCodeCliAdapter implements AgentAdapter {
  readonly events = new AdapterEventBus();

  constructor(private readonly opts: OpenCodeCliAdapterOptions) {}

  async invoke(spec: InvocationSpec): Promise<string> {
    const provider: Provider = this.opts.provider ?? 'anthropic';
    const envVar = PROVIDER_ENV_VAR[provider];
    if (!envVar) {
      throw new Error(
        `OpenCode CLI adapter does not support provider "${provider}". ` +
          `Use anthropic, openai, or google.`
      );
    }
    const cred = await this.opts.broker.getCredential(provider);
    const bin = this.opts.bin ?? 'opencode';
    const model = this.opts.model ?? 'anthropic/claude-opus-4-7';
    const timeoutMs = this.opts.timeoutMs ?? 60_000;

    const configDir = makeMcpSuppressedConfigDir();

    const env: NodeJS.ProcessEnv = {
      [envVar]: cred.apiKey,
      OPENCODE_DISABLE_MCP: '1',
      XDG_CONFIG_HOME: configDir,
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME,
    };

    // OpenCode CLI takes one positional prompt; we flatten system+user with
    // a delimiter for the wire while emitting the structured shape to observers.
    const wirePrompt = spec.system ? `${spec.system}\n\n${spec.user}` : spec.user;

    this.events.emit({
      kind: 'request',
      ts: new Date().toISOString(),
      system: spec.system,
      user: spec.user,
      model,
      provider,
    });

    return await new Promise<string>((resolve, reject) => {
      const child = spawn(bin, ['run', '--no-mcp', '--model', model, wirePrompt], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2_000);
      }, timeoutMs);

      child.stdout.on('data', (c) => (stdout += c.toString()));
      child.stderr.on('data', (c) => (stderr += c.toString()));

      child.on('error', (err) => {
        clearTimeout(timer);
        const wrapped =
          err.message.includes('ENOENT')
            ? new Error(`opencode binary not found: \`${bin}\`. Install it or pass { bin: <path> }.`)
            : err;
        this.events.emit({
          kind: 'error',
          ts: new Date().toISOString(),
          message: wrapped.message,
          cause: err,
        });
        reject(wrapped);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (killed) {
          const err = new Error(`opencode timed out after ${timeoutMs}ms`);
          this.events.emit({
            kind: 'error',
            ts: new Date().toISOString(),
            message: err.message,
          });
          return reject(err);
        }
        if (code !== 0) {
          const err = new Error(`opencode exited ${code}: ${stderr.slice(0, 500)}`);
          this.events.emit({
            kind: 'error',
            ts: new Date().toISOString(),
            message: err.message,
          });
          return reject(err);
        }
        this.events.emit({
          kind: 'response',
          ts: new Date().toISOString(),
          text: stdout,
        });
        resolve(stdout);
      });
    });
  }
}

/**
 * Defense-in-depth MCP kill-switch via a tmp config dir with an empty mcp block.
 * Pairs with OPENCODE_DISABLE_MCP env and the --no-mcp flag — any of the three
 * working is enough; relying on only one is fragile across opencode versions.
 */
function makeMcpSuppressedConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-mcp-suppressed-'));
  writeFileSync(join(dir, 'opencode.json'), JSON.stringify({ mcp: {} }), { mode: 0o600 });
  return dir;
}
