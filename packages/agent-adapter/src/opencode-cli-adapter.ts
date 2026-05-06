import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

  /**
   * HTTP endpoint of an OpenAI-compatible inference server. When set, the
   * adapter SKIPS broker credential lookup and writes a custom provider
   * definition into opencode.json pointing at this baseURL. Use for
   * self-hosted models like `ai/qwen3-coder` (exposed by llama-server with
   * an OpenAI-compatible /v1/chat/completions endpoint).
   *
   * Example: `http://agent-llm:8080/v1`
   */
  endpoint?: string;

  /**
   * Logical provider id used in opencode.json's providers block and as the
   * model-id prefix. Defaults to `'local'`. The model spec passed to OpenCode
   * becomes `<endpointProviderId>/<model name>` — e.g., `local/qwen3-coder`.
   */
  endpointProviderId?: string;

  /**
   * Static API key string passed to OpenCode for the local endpoint. Most
   * self-hosted servers ignore the key entirely but OpenCode still requires
   * the field to be present. Defaults to a placeholder string.
   */
  staticApiKey?: string;

  /**
   * URL of a long-running `opencode serve` instance — when set, the adapter
   * spawns `opencode run --attach <serverUrl> ...` instead of the
   * standalone form. Per memory `feedback_opencode_http_mode`, this is the
   * shape that lets a per-job harness-pipeline container share a single
   * warm opencode-server across N adapter invocations: the heavy lifts
   * (model load, plugin discovery, config parse) happen once at server
   * boot, and each invoke's client subprocess is a thin wrapper.
   *
   * Caller (typically harness-pipeline) is responsible for the server's
   * lifecycle — see `OpenCodeServer` for a helper. Adapter does not start
   * or stop the server; it only attaches.
   *
   * Compatible with `endpoint` (custom upstream model server): the
   * opencode-server has its own opencode.json that points at the upstream;
   * the adapter via --attach just routes through that server.
   */
  serverUrl?: string;
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
    const isLocal = !!this.opts.endpoint;

    const bin = this.opts.bin ?? 'opencode';
    const timeoutMs = this.opts.timeoutMs ?? 60_000;

    let model: string;
    let providerLabel: string;
    let env: NodeJS.ProcessEnv;
    let configDir: string;

    if (isLocal) {
      const providerId = this.opts.endpointProviderId ?? 'local';
      providerLabel = providerId;
      // For local endpoints, model defaults to `<providerId>/qwen3-coder`.
      // Caller can override fully by passing an explicit `model` option.
      model = this.opts.model ?? `${providerId}/qwen3-coder`;
      // Extract the model-id portion (after the first `/`) to register
      // it in the opencode provider config. opencode 1.4 throws
      // ProviderModelNotFoundError without this entry even for
      // OpenAI-compatible custom providers.
      const slashIdx = model.indexOf('/');
      const registerModelId = slashIdx > 0 ? model.slice(slashIdx + 1) : model;
      configDir = makeOpencodeConfigDir({
        endpoint: this.opts.endpoint!,
        endpointProviderId: providerId,
        apiKey: this.opts.staticApiKey ?? 'no-auth-required',
        registerModelId,
      });
      env = {
        OPENCODE_DISABLE_MCP: '1',
        XDG_CONFIG_HOME: configDir,
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME,
      };
    } else {
      const provider: Provider = this.opts.provider ?? 'anthropic';
      const envVar = PROVIDER_ENV_VAR[provider];
      if (!envVar) {
        throw new Error(
          `OpenCode CLI adapter does not support provider "${provider}". ` +
            `Use anthropic, openai, google, or set { endpoint } for a self-hosted server.`
        );
      }
      const cred = await this.opts.broker.getCredential(provider);
      providerLabel = provider;
      model = this.opts.model ?? 'anthropic/claude-opus-4-7';
      configDir = makeOpencodeConfigDir({});
      env = {
        [envVar]: cred.apiKey,
        OPENCODE_DISABLE_MCP: '1',
        XDG_CONFIG_HOME: configDir,
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME,
      };
    }

    // OpenCode CLI takes one positional prompt; we flatten system+user with
    // a delimiter for the wire while emitting the structured shape to observers.
    const wirePrompt = spec.system ? `${spec.system}\n\n${spec.user}` : spec.user;

    this.events.emit({
      kind: 'request',
      ts: new Date().toISOString(),
      system: spec.system,
      user: spec.user,
      model,
      provider: providerLabel,
    });

    // Construct argv. When `serverUrl` is set, the client subprocess
    // attaches to a long-running `opencode serve` instance — the heavy
    // setup (model load, plugin discovery, config parse) already happened
    // server-side, so the client's job is just to forward the request.
    // See OpenCodeServer for the lifecycle helper that owns the server.
    //
    // `--pure` disables external plugins (opencode 1.4.x naming —
    // earlier versions called this `--no-mcp`). Combined with the
    // OPENCODE_DISABLE_MCP=1 env var below for belt-and-suspenders.
    //
    // `--thinking` surfaces reasoning blocks. Reasoning models like
    // Qwen3-thinking put their answer in `reasoning_content` rather
    // than `content`; without this flag opencode hides reasoning and
    // we see an empty response. Cost: a bit of extra output for non-
    // reasoning models. Worth it for correctness.
    const cliArgs: string[] = ['run'];
    if (this.opts.serverUrl) {
      cliArgs.push('--attach', this.opts.serverUrl);
    }
    cliArgs.push('--pure', '--thinking', '--model', model, wirePrompt);

    return await new Promise<string>((resolve, reject) => {
      const child = spawn(bin, cliArgs, {
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

interface OpencodeConfigDirOpts {
  /** When set, registers a custom OpenAI-compatible provider. */
  endpoint?: string;
  /** Provider id in opencode.json; required when `endpoint` is set. */
  endpointProviderId?: string;
  /** API key string OpenCode passes to the provider; required when `endpoint` is set. */
  apiKey?: string;
  /** Model id (without the `<provider>/` prefix) to register on the
   *  endpoint provider. OpenCode 1.4.x rejects `--model <provider>/<id>`
   *  with `ProviderModelNotFoundError` unless the id appears in the
   *  provider's `models` map — even for OpenAI-compatible custom
   *  providers. Required when `endpoint` is set; ignored otherwise. */
  registerModelId?: string;
}

/**
 * Writes a tmp opencode.json that:
 *   - Always suppresses MCP (defense-in-depth alongside OPENCODE_DISABLE_MCP env
 *     and the --pure CLI flag).
 *   - Optionally registers a custom OpenAI-compatible provider when `endpoint`
 *     is set, so OpenCode routes inference there instead of the default Anthropic
 *     / OpenAI / Google paths. The provider entry includes a `models` map with
 *     the specific model id registered — opencode 1.4.x throws
 *     ProviderModelNotFoundError without this even though baseURL is set.
 *
 * Returns the directory that should be passed as XDG_CONFIG_HOME to the
 * opencode subprocess.
 */
function makeOpencodeConfigDir(opts: OpencodeConfigDirOpts): string {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-cfg-'));
  const config: Record<string, unknown> = { mcp: {} };
  if (opts.endpoint) {
    const id = opts.endpointProviderId ?? 'local';
    const providerEntry: Record<string, unknown> = {
      options: {
        baseURL: opts.endpoint,
        apiKey: opts.apiKey ?? 'no-auth-required',
      },
    };
    if (opts.registerModelId) {
      // Register the specific model id — opencode 1.4 requires it under
      // `models.<id>` even for OpenAI-compatible custom providers, or the
      // CLI throws ProviderModelNotFoundError before the request goes out.
      providerEntry.models = { [opts.registerModelId]: {} };
    }
    config.provider = { [id]: providerEntry };
  }
  // XDG convention: `<XDG_CONFIG_HOME>/<app>/<file>`. opencode 1.4 looks
  // in `<XDG_CONFIG_HOME>/opencode/opencode.json` (verified via
  // --print-logs `service=config path=…/opencode/opencode.json loading`).
  // The earlier flat-write path silently failed — opencode loaded its
  // built-in providers and ignored ours.
  const opencodeConfigDir = join(dir, 'opencode');
  mkdirSync(opencodeConfigDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(opencodeConfigDir, 'opencode.json'), JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
  return dir;
}
