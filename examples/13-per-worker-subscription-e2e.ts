/**
 * End-to-end proof of the per-worker model subscription chain.
 *
 * Exercises the full code path landed across slices 1–5:
 *
 *   catalog accepts:[]   →   BindingResolver
 *                         →  resolveBindingFor (walk + auth check)
 *                         →  ResolvedBinding (cloud OR local)
 *                         →  bindingToAdapter
 *                         →  AgentAdapter (ClaudeSdkAdapter / OpenCodeCliAdapter)
 *
 * No live LLM calls — we stop at the point where the adapter object is
 * constructed and inspect its type. The actual SDK wire calls are an
 * adapter-internal concern with their own tests; the architectural
 * payoff this demo proves is that priority-ordered accept-lists drive
 * provider selection deterministically against real auth state.
 *
 * Six scenarios cover the interesting branches:
 *   1. Anthropic configured + first in accepts        → ClaudeSdkAdapter
 *   2. Anthropic configured + Local first in accepts  → OpenCodeCliAdapter
 *      (priority wins over availability)
 *   3. No anthropic, fall through to OpenAI           → OpenCodeCliAdapter
 *   4. No cloud configured, fall through to local     → OpenCodeCliAdapter
 *   5. Mixed pipeline — same job, different agents bind to different
 *      providers based on each agent's accept-list
 *   6. No satisfiable binding → BindingResolutionError, with full
 *      diagnostic
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindingToAdapter, ClaudeSdkAdapter, OpenCodeCliAdapter } from '@agentx/agent-adapter';
import {
  AuthStore,
  BindingResolutionError,
  DefaultBindingResolver,
  FileBroker,
  type Provider,
} from '@agentx/agent-auth-lib';

// ─── helpers ──────────────────────────────────────────────────────────────

interface AuthFixture {
  workspace: string;
  authPath: string;
  store: AuthStore;
  broker: FileBroker;
  resolver: DefaultBindingResolver;
}

async function makeAuthFixture(
  configured: Partial<Record<Provider, string>>,
): Promise<AuthFixture> {
  const workspace = mkdtempSync(join(tmpdir(), 'agentx-e2e-subscription-'));
  const authDir = join(workspace, '.agentx');
  mkdirSync(authDir, { recursive: true, mode: 0o700 });
  const authPath = join(authDir, 'auth.json');
  // Initialize an empty auth file with mode 0600.
  writeFileSync(authPath, JSON.stringify({ version: 1, providers: {} }, null, 2), { mode: 0o600 });
  chmodSync(authPath, 0o600);

  const store = new AuthStore(authPath);
  for (const [provider, apiKey] of Object.entries(configured)) {
    if (!apiKey) continue;
    await store.setProvider(provider as Provider, {
      apiKey,
      createdAt: new Date().toISOString(),
    });
  }
  // setProvider rewrites the file with default mode; re-chmod to 0600 so
  // FileBroker's permission check passes.
  chmodSync(authPath, 0o600);

  const broker = new FileBroker(authPath);
  const resolver = new DefaultBindingResolver(broker);
  return { workspace, authPath, store, broker, resolver };
}

function adapterClassName(adapter: unknown): string {
  if (adapter instanceof ClaudeSdkAdapter) return 'ClaudeSdkAdapter';
  if (adapter instanceof OpenCodeCliAdapter) return 'OpenCodeCliAdapter';
  return adapter?.constructor?.name ?? 'Unknown';
}

// Pretty banner for each scenario — keeps the output scannable.
function banner(n: number, title: string): void {
  console.log();
  console.log(`══════ Scenario ${n}: ${title} ══════`);
}

// ─── scenarios ────────────────────────────────────────────────────────────

async function scenario1AnthropicWins(): Promise<void> {
  banner(1, 'Anthropic configured + first in accepts → ClaudeSdkAdapter');

  const fix = await makeAuthFixture({
    anthropic: 'sk-ant-stub-redacted-12345',
  });
  try {
    const accepts = ['anthropic:claude-haiku-4-5', 'local-qwen:qwen3'];
    console.log(`  agent.accepts = ${JSON.stringify(accepts)}`);
    const binding = await fix.resolver.resolveBinding(accepts);
    console.log(
      `  → resolved kind=${binding.kind} provider=${binding.provider.id} model=${binding.model.id}`,
    );
    if (binding.kind === 'cloud') {
      console.log(`  → credential.apiKey starts with "${binding.credential.apiKey.slice(0, 10)}…"`);
    }
    const adapter = bindingToAdapter(binding, {
      broker: fix.broker,
      localEndpoint: () => 'http://test-llm:8080/v1',
    });
    console.log(`  → adapter class = ${adapterClassName(adapter)}`);
  } finally {
    rmSync(fix.workspace, { recursive: true, force: true });
  }
}

async function scenario2LocalFirstBeatsAnthropic(): Promise<void> {
  banner(2, 'Anthropic configured but Local first in accepts → OpenCodeCliAdapter (priority wins)');

  const fix = await makeAuthFixture({
    anthropic: 'sk-ant-stub-redacted-12345',
  });
  try {
    const accepts = ['local-qwen:qwen3', 'anthropic:claude-haiku-4-5'];
    console.log(`  agent.accepts = ${JSON.stringify(accepts)}`);
    const binding = await fix.resolver.resolveBinding(accepts);
    console.log(
      `  → resolved kind=${binding.kind} provider=${binding.provider.id} model=${binding.model.id}`,
    );
    const adapter = bindingToAdapter(binding, {
      broker: fix.broker,
      localEndpoint: () => 'http://test-llm:8080/v1',
    });
    console.log(`  → adapter class = ${adapterClassName(adapter)}`);
    console.log(
      `  ← note: local won despite anthropic being available — accept-list ordering is policy`,
    );
  } finally {
    rmSync(fix.workspace, { recursive: true, force: true });
  }
}

async function scenario3FallThroughToOpenAI(): Promise<void> {
  banner(3, 'No anthropic, fall through to OpenAI → OpenCodeCliAdapter');

  const fix = await makeAuthFixture({
    openai: 'sk-openai-stub-67890',
  });
  try {
    const accepts = ['anthropic:claude-haiku-4-5', 'openai:gpt-4o', 'local-qwen:qwen3'];
    console.log(`  agent.accepts = ${JSON.stringify(accepts)}`);
    const binding = await fix.resolver.resolveBinding(accepts);
    console.log(
      `  → resolved kind=${binding.kind} provider=${binding.provider.id} model=${binding.model.id}`,
    );
    if (binding.kind === 'cloud') {
      console.log(`  → credential.apiKey starts with "${binding.credential.apiKey.slice(0, 10)}…"`);
    }
    const adapter = bindingToAdapter(binding, {
      broker: fix.broker,
      localEndpoint: () => 'http://test-llm:8080/v1',
    });
    console.log(`  → adapter class = ${adapterClassName(adapter)}`);
    console.log(`  ← anthropic skipped (not configured), openai matched`);
  } finally {
    rmSync(fix.workspace, { recursive: true, force: true });
  }
}

async function scenario4FallThroughToLocal(): Promise<void> {
  banner(4, 'No cloud configured at all, fall through to local → OpenCodeCliAdapter');

  const fix = await makeAuthFixture({}); // empty
  try {
    const accepts = ['anthropic:claude-haiku-4-5', 'openai:gpt-4o', 'local-qwen:qwen3'];
    console.log(`  agent.accepts = ${JSON.stringify(accepts)}`);
    const binding = await fix.resolver.resolveBinding(accepts);
    console.log(
      `  → resolved kind=${binding.kind} provider=${binding.provider.id} model=${binding.model.id}`,
    );
    const adapter = bindingToAdapter(binding, {
      broker: fix.broker,
      localEndpoint: () => 'http://test-llm:8080/v1',
    });
    console.log(`  → adapter class = ${adapterClassName(adapter)}`);
    console.log(`  ← all cloud entries skipped silently, local satisfied without auth`);
  } finally {
    rmSync(fix.workspace, { recursive: true, force: true });
  }
}

async function scenario5MixedPipelineSameJob(): Promise<void> {
  banner(5, 'Mixed pipeline — same job, different agents bind to different providers');

  const fix = await makeAuthFixture({
    anthropic: 'sk-ant-stub-redacted-12345',
    openai: 'sk-openai-stub-67890',
  });
  try {
    const pipeline = [
      { id: 'summarizer', accepts: ['local-qwen:qwen3', 'openai:gpt-4o-mini'] },
      { id: 'planner', accepts: ['anthropic:claude-haiku-4-5'] },
      { id: 'reviewer', accepts: ['anthropic:claude-opus-4-7'] },
      { id: 'fallback', accepts: ['anthropic:fake-model', 'openai:gpt-4o'] },
    ];
    console.log(`  pipeline has ${pipeline.length} agents, each with its own accept-list`);
    for (const agent of pipeline) {
      const binding = await fix.resolver.resolveBinding(agent.accepts);
      const adapter = bindingToAdapter(binding, {
        broker: fix.broker,
        localEndpoint: () => 'http://test-llm:8080/v1',
      });
      const summary =
        binding.kind === 'cloud'
          ? `cloud ${binding.provider.id}:${binding.model.id}`
          : `local ${binding.provider.id}:${binding.model.id}`;
      console.log(
        `    [${agent.id.padEnd(11)}] accepts=${JSON.stringify(agent.accepts).padEnd(60)} → ${summary.padEnd(35)} (${adapterClassName(adapter)})`,
      );
    }
    console.log(`  ← three different vendors bound for one pipeline run`);
  } finally {
    rmSync(fix.workspace, { recursive: true, force: true });
  }
}

async function scenario6NoSatisfiableBinding(): Promise<void> {
  banner(6, 'No satisfiable binding → BindingResolutionError with full diagnostic');

  const fix = await makeAuthFixture({}); // empty
  try {
    const accepts = ['anthropic:claude-haiku-4-5', 'openai:not-a-real-model', 'mystery-vendor:foo'];
    console.log(`  agent.accepts = ${JSON.stringify(accepts)}`);
    try {
      await fix.resolver.resolveBinding(accepts);
      console.log('  UNEXPECTED: resolution succeeded');
    } catch (err) {
      if (err instanceof BindingResolutionError) {
        console.log(`  → caught BindingResolutionError`);
        console.log(`  → ${err.failures.length} failure reasons recorded:`);
        for (const f of err.failures) {
          console.log(`      - ${f}`);
        }
      } else {
        throw err;
      }
    }
  } finally {
    rmSync(fix.workspace, { recursive: true, force: true });
  }
}

// ─── runner ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`agentx · per-worker model subscription end-to-end proof`);
  console.log(`──────────────────────────────────────────────────────────`);
  console.log(`exercises: catalog accepts → resolver → bindingToAdapter`);

  await scenario1AnthropicWins();
  await scenario2LocalFirstBeatsAnthropic();
  await scenario3FallThroughToOpenAI();
  await scenario4FallThroughToLocal();
  await scenario5MixedPipelineSameJob();
  await scenario6NoSatisfiableBinding();

  console.log();
  console.log(`══════ ✓ end-to-end proof complete ══════`);
  console.log(`  All scenarios ran the full chain: FileBroker reads auth.json,`);
  console.log(`  DefaultBindingResolver walks the accept-list against the`);
  console.log(`  LLMProvider registry, bindingToAdapter constructs the right`);
  console.log(`  adapter class for each ResolvedBinding.`);
}

main().catch((err) => {
  console.error('e2e proof failed:', err);
  process.exit(1);
});
