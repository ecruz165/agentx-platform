import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterEvent } from './events.ts';

const mockSpawn = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

/**
 * Build a fake ChildProcess that emits the given stdout then closes with the
 * given exit code on the next event-loop tick. Mirrors the surface of
 * node:child_process's ChildProcess that OpenCodeCliAdapter consumes.
 */
function fakeChild(stdout = 'mock output', exitCode = 0): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  setImmediate(() => {
    child.stdout.emit('data', Buffer.from(stdout));
    setImmediate(() => child.emit('close', exitCode));
  });
  return child;
}

function lastSpawnCall(): {
  cmd: string;
  args: string[];
  opts: { env: NodeJS.ProcessEnv };
} {
  const calls = mockSpawn.mock.calls;
  if (calls.length === 0) throw new Error('spawn was never called');
  const [cmd, args, opts] = calls[calls.length - 1] as [
    string,
    string[],
    { env: NodeJS.ProcessEnv },
  ];
  return { cmd, args, opts };
}

describe('OpenCodeCliAdapter — local endpoint path', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it('skips broker credential lookup when endpoint is set', async () => {
    mockSpawn.mockImplementation(() => fakeChild('hello'));
    const { OpenCodeCliAdapter } = await import('./opencode-cli-adapter.ts');
    const broker = { getCredential: vi.fn() };

    const adapter = new OpenCodeCliAdapter({
      broker: broker as never,
      endpoint: 'http://agent-llm:8080/v1',
    });
    await adapter.invoke({ user: 'hi' });

    expect(broker.getCredential).not.toHaveBeenCalled();
  });

  it('writes opencode.json with the custom provider when endpoint is set', async () => {
    mockSpawn.mockImplementation(() => fakeChild('hello'));
    const { OpenCodeCliAdapter } = await import('./opencode-cli-adapter.ts');
    const broker = { getCredential: vi.fn() };

    const adapter = new OpenCodeCliAdapter({
      broker: broker as never,
      endpoint: 'http://agent-llm:8080/v1',
      endpointProviderId: 'qwen-local',
      staticApiKey: 'test-key-ignored-by-server',
    });
    await adapter.invoke({ user: 'hi' });

    const { opts } = lastSpawnCall();
    const configDir = opts.env.XDG_CONFIG_HOME;
    expect(configDir).toBeDefined();
    const cfg = JSON.parse(
      readFileSync(join(configDir!, 'opencode', 'opencode.json'), 'utf8')
    );
    // The default model is `<providerId>/qwen3-coder` so the registered
    // model id is `qwen3-coder`. opencode 1.4 requires this models map.
    expect(cfg).toEqual({
      mcp: {},
      provider: {
        'qwen-local': {
          options: {
            baseURL: 'http://agent-llm:8080/v1',
            apiKey: 'test-key-ignored-by-server',
          },
          models: {
            'qwen3-coder': {},
          },
        },
      },
    });
  });

  it('uses `<providerId>/qwen3-coder` as the default model when endpoint is set', async () => {
    mockSpawn.mockImplementation(() => fakeChild('hello'));
    const { OpenCodeCliAdapter } = await import('./opencode-cli-adapter.ts');
    const broker = { getCredential: vi.fn() };

    const adapter = new OpenCodeCliAdapter({
      broker: broker as never,
      endpoint: 'http://agent-llm:8080/v1',
      endpointProviderId: 'local',
    });
    await adapter.invoke({ user: 'hi' });

    const { args } = lastSpawnCall();
    const modelIdx = args.indexOf('--model');
    expect(args[modelIdx + 1]).toBe('local/qwen3-coder');
  });

  it('honours an explicit model option even when endpoint is set', async () => {
    mockSpawn.mockImplementation(() => fakeChild('hello'));
    const { OpenCodeCliAdapter } = await import('./opencode-cli-adapter.ts');
    const broker = { getCredential: vi.fn() };

    const adapter = new OpenCodeCliAdapter({
      broker: broker as never,
      endpoint: 'http://agent-llm:8080/v1',
      endpointProviderId: 'local',
      model: 'local/qwen3-coder-30b-a3b',
    });
    await adapter.invoke({ user: 'hi' });

    const { args } = lastSpawnCall();
    expect(args[args.indexOf('--model') + 1]).toBe('local/qwen3-coder-30b-a3b');
  });

  it('emits the request event with provider = endpointProviderId', async () => {
    mockSpawn.mockImplementation(() => fakeChild('hello'));
    const { OpenCodeCliAdapter } = await import('./opencode-cli-adapter.ts');
    const broker = { getCredential: vi.fn() };

    const adapter = new OpenCodeCliAdapter({
      broker: broker as never,
      endpoint: 'http://agent-llm:8080/v1',
      endpointProviderId: 'qwen-local',
    });
    const events: AdapterEvent[] = [];
    adapter.events.subscribe((e) => events.push(e));

    await adapter.invoke({ system: 'be brief', user: 'hi' });

    expect(events[0]).toMatchObject({
      kind: 'request',
      system: 'be brief',
      user: 'hi',
      model: 'qwen-local/qwen3-coder',
      provider: 'qwen-local',
    });
  });

  it('does NOT set ANTHROPIC_API_KEY in env when endpoint is set', async () => {
    mockSpawn.mockImplementation(() => fakeChild('hello'));
    const { OpenCodeCliAdapter } = await import('./opencode-cli-adapter.ts');
    const broker = { getCredential: vi.fn() };

    const adapter = new OpenCodeCliAdapter({
      broker: broker as never,
      endpoint: 'http://agent-llm:8080/v1',
    });
    await adapter.invoke({ user: 'hi' });

    const { opts } = lastSpawnCall();
    expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(opts.env.OPENAI_API_KEY).toBeUndefined();
    expect(opts.env.GOOGLE_API_KEY).toBeUndefined();
  });
});

describe('OpenCodeCliAdapter — hosted-provider path (regression)', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it('still calls broker for anthropic credentials when no endpoint is set', async () => {
    mockSpawn.mockImplementation(() => fakeChild('hello'));
    const { OpenCodeCliAdapter } = await import('./opencode-cli-adapter.ts');
    const broker = {
      getCredential: vi.fn().mockResolvedValue({
        provider: 'anthropic',
        apiKey: 'sk-ant-fake',
        source: 'test',
      }),
    };

    const adapter = new OpenCodeCliAdapter({ broker: broker as never });
    await adapter.invoke({ user: 'hi' });

    expect(broker.getCredential).toHaveBeenCalledWith('anthropic');
    const { opts } = lastSpawnCall();
    expect(opts.env.ANTHROPIC_API_KEY).toBe('sk-ant-fake');
  });

  it('still suppresses MCP via opencode.json when no endpoint is set', async () => {
    mockSpawn.mockImplementation(() => fakeChild('hello'));
    const { OpenCodeCliAdapter } = await import('./opencode-cli-adapter.ts');
    const broker = {
      getCredential: vi.fn().mockResolvedValue({
        provider: 'anthropic',
        apiKey: 'sk-ant-fake',
        source: 'test',
      }),
    };

    const adapter = new OpenCodeCliAdapter({ broker: broker as never });
    await adapter.invoke({ user: 'hi' });

    const { opts } = lastSpawnCall();
    const cfg = JSON.parse(
      readFileSync(join(opts.env.XDG_CONFIG_HOME!, 'opencode', 'opencode.json'), 'utf8')
    );
    expect(cfg.mcp).toEqual({});
    expect(cfg.provider).toBeUndefined();
  });
});

describe('OpenCodeCliAdapter — serverUrl (HTTP server attach)', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it('passes --attach <serverUrl> to opencode run when serverUrl is set', async () => {
    mockSpawn.mockImplementation(() => fakeChild('hello'));
    const { OpenCodeCliAdapter } = await import('./opencode-cli-adapter.ts');
    const broker = {
      getCredential: vi.fn().mockResolvedValue({
        provider: 'anthropic',
        apiKey: 'sk-ant-fake',
        source: 'test',
      }),
    };

    const adapter = new OpenCodeCliAdapter({
      broker: broker as never,
      serverUrl: 'http://127.0.0.1:31337',
    });
    await adapter.invoke({ user: 'hi' });

    const { args } = lastSpawnCall();
    // Argv shape: ['run', '--attach', '<url>', '--pure', '--model', '<model>', '<prompt>']
    expect(args[0]).toBe('run');
    expect(args[1]).toBe('--attach');
    expect(args[2]).toBe('http://127.0.0.1:31337');
    expect(args).toContain('--model');
  });

  it('does NOT include --attach when serverUrl is unset (back compat)', async () => {
    mockSpawn.mockImplementation(() => fakeChild('hello'));
    const { OpenCodeCliAdapter } = await import('./opencode-cli-adapter.ts');
    const broker = {
      getCredential: vi.fn().mockResolvedValue({
        provider: 'anthropic',
        apiKey: 'sk-ant-fake',
        source: 'test',
      }),
    };

    const adapter = new OpenCodeCliAdapter({ broker: broker as never });
    await adapter.invoke({ user: 'hi' });

    const { args } = lastSpawnCall();
    expect(args).not.toContain('--attach');
    expect(args[0]).toBe('run');
    expect(args[1]).toBe('--pure');
  });

  it('serverUrl coexists with endpoint (custom upstream model server)', async () => {
    mockSpawn.mockImplementation(() => fakeChild('hello'));
    const { OpenCodeCliAdapter } = await import('./opencode-cli-adapter.ts');
    const broker = { getCredential: vi.fn() };

    const adapter = new OpenCodeCliAdapter({
      broker: broker as never,
      endpoint: 'http://agent-llm:8080/v1',
      endpointProviderId: 'local-qwen',
      serverUrl: 'http://127.0.0.1:31337',
    });
    await adapter.invoke({ user: 'hi' });

    const { args } = lastSpawnCall();
    // Both --attach and the endpoint config (broker not consulted, opencode.json
    // written) should be present together.
    expect(args).toContain('--attach');
    expect(args).toContain('http://127.0.0.1:31337');
    expect(broker.getCredential).not.toHaveBeenCalled();
  });

  it('serverUrl threads through model resolution unchanged', async () => {
    mockSpawn.mockImplementation(() => fakeChild('hello'));
    const { OpenCodeCliAdapter } = await import('./opencode-cli-adapter.ts');
    const broker = {
      getCredential: vi.fn().mockResolvedValue({
        provider: 'anthropic',
        apiKey: 'sk-ant-fake',
        source: 'test',
      }),
    };

    const adapter = new OpenCodeCliAdapter({
      broker: broker as never,
      serverUrl: 'http://127.0.0.1:31337',
      model: 'anthropic/claude-haiku-4-5',
    });
    await adapter.invoke({ user: 'hi' });

    const { args } = lastSpawnCall();
    const modelIdx = args.indexOf('--model');
    expect(modelIdx).toBeGreaterThan(-1);
    expect(args[modelIdx + 1]).toBe('anthropic/claude-haiku-4-5');
  });
});
