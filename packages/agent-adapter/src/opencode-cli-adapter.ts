import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CredentialBroker, Provider } from '@agentx/auth-lib';
import type { AgentAdapter, CaptureSink } from './types.ts';

export interface OpenCodeCliAdapterOptions {
  broker: CredentialBroker;
  capture: CaptureSink;
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
  constructor(private readonly opts: OpenCodeCliAdapterOptions) {}

  async invoke(prompt: string): Promise<string> {
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

    await this.opts.capture.write({
      ts: new Date().toISOString(),
      kind: 'request',
      payload: {
        bin,
        model,
        provider,
        promptLength: prompt.length,
        mcpSuppression: ['env:OPENCODE_DISABLE_MCP', 'config:empty-mcp', 'flag:--no-mcp'],
        _credentialSource: cred.source,
      },
    });

    return await new Promise<string>((resolve, reject) => {
      const child = spawn(bin, ['run', '--no-mcp', '--model', model, prompt], {
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
        reject(
          err.message.includes('ENOENT')
            ? new Error(`opencode binary not found: \`${bin}\`. Install it or pass { bin: <path> }.`)
            : err
        );
      });

      child.on('close', async (code) => {
        clearTimeout(timer);
        if (killed) {
          return reject(new Error(`opencode timed out after ${timeoutMs}ms`));
        }
        if (code !== 0) {
          await this.opts.capture.write({
            ts: new Date().toISOString(),
            kind: 'error',
            payload: { exitCode: code, stderr },
          });
          return reject(new Error(`opencode exited ${code}: ${stderr.slice(0, 500)}`));
        }
        await this.opts.capture.write({
          ts: new Date().toISOString(),
          kind: 'response',
          payload: { stdout },
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
