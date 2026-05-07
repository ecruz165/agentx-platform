/**
 * REAL end-to-end proof of the per-worker model subscription chain
 * driving an actual local Qwen LLM via Docker Model Runner.
 *
 * What this exercises (live, not stubbed):
 *
 *   ~/.agentx/auth.json      ← FileBroker reads (stub key — local-qwen
 *                              has authMethods=[], so auth doesn't matter)
 *   accept-list              ← DefaultBindingResolver picks first
 *                              satisfiable entry
 *   ResolvedBinding.local    ← matches local-qwen
 *   bindingToAdapter         ← constructs OpenCodeCliAdapter pointed at
 *                              DMR's chat-completions endpoint
 *   adapter.invoke(...)      ← spawns `opencode run` which posts to DMR's
 *                              /v1/chat/completions with the model name
 *                              from registry.vendorModelId
 *   DMR + ai/qwen3:0.6B-Q4_K_M  ← actual local LLM, returns real response
 *
 * Prerequisites:
 *   - Docker Model Runner running on localhost:12434
 *   - `docker model pull ai/qwen3:0.6B-Q4_K_M` (~456 MiB, one-time)
 *   - `opencode` CLI on PATH (1.4.x)
 *
 * Why this script doesn't go through `runHarnessPipeline`:
 *   The new architecture's `runHarnessPipeline` lazy-spawns its own
 *   `opencode serve` and uses `opencode run --attach` for adapter calls
 *   — but the server's provider config (where DMR lives) hasn't been
 *   wired through spec.bindings yet (slice 9c-3 follow-up). For now this
 *   demo exercises the resolver → bindingToAdapter chain directly,
 *   letting OpenCodeCliAdapter run in standalone mode against DMR. That
 *   chain is the load-bearing architectural payoff; --attach is a perf
 *   optimization that lands separately.
 *
 * Run with:
 *   bun examples/14-real-qwen-e2e.ts
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindingToAdapter } from '@ecruz165/agent-adapter';
import { AuthStore, DefaultBindingResolver, FileBroker } from '@ecruz165/agent-auth';

const DMR_CHAT_URL = 'http://localhost:12434/engines/llama.cpp/v1';

// ─── helpers ──────────────────────────────────────────────────────────────

async function makeFixture(): Promise<{
  workspace: string;
  broker: FileBroker;
  resolver: DefaultBindingResolver;
}> {
  const workspace = mkdtempSync(join(tmpdir(), 'agentx-real-qwen-'));
  const authDir = join(workspace, '.agentx');
  mkdirSync(authDir, { recursive: true, mode: 0o700 });
  const authPath = join(authDir, 'auth.json');
  writeFileSync(authPath, JSON.stringify({ version: 1, providers: {} }, null, 2), { mode: 0o600 });
  chmodSync(authPath, 0o600);

  const store = new AuthStore(authPath);
  // Local-qwen has authMethods=[] so no entry is needed; this is just to
  // demonstrate that the FileBroker path works even with empty providers.
  void store;

  const broker = new FileBroker(authPath);
  const resolver = new DefaultBindingResolver(broker);
  return { workspace, broker, resolver };
}

async function preflight(): Promise<void> {
  console.log('preflight…');
  // 1. DMR up?
  const modelsRes = await fetch(
    `${DMR_CHAT_URL.replace(/\/engines\/llama\.cpp\/v1$/, '')}/v1/models`,
  ).catch(() => null);
  if (!modelsRes?.ok) {
    throw new Error(
      `Docker Model Runner not reachable at localhost:12434. ` +
        `Make sure Docker Desktop is running and the model runner is enabled.`,
    );
  }
  const json = await modelsRes.json();
  const models: string[] = (json.data ?? []).map((m: { id: string }) => m.id);
  const want = 'docker.io/ai/qwen3:0.6B-Q4_K_M';
  if (!models.some((m) => m === want || m.endsWith('ai/qwen3:0.6B-Q4_K_M'))) {
    throw new Error(
      `DMR has no qwen3 chat model loaded. Available: ${models.join(', ')}\n` +
        `Pull with: docker model pull ai/qwen3:0.6B-Q4_K_M`,
    );
  }
  console.log('  ✓ DMR up, qwen3:0.6B-Q4_K_M available');

  // 2. opencode binary
  try {
    const proc = Bun.spawnSync(['opencode', '--version']);
    if (proc.exitCode !== 0) throw new Error('opencode --version exited non-zero');
    console.log(`  ✓ opencode CLI found (${proc.stdout.toString().trim()})`);
  } catch {
    throw new Error('opencode CLI not found on PATH. Install via: brew install opencode');
  }
  console.log();
}

// ─── main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('agentx · REAL end-to-end proof');
  console.log('────────────────────────────────────────────────');
  console.log('catalog accepts → resolver → bindingToAdapter →');
  console.log('OpenCodeCliAdapter → opencode run → DMR → live Qwen');
  console.log();

  await preflight();

  const fix = await makeFixture();
  try {
    // Step 1: resolve the accept-list. With no auth configured, only local
    // bindings can satisfy — exactly what we want to drive Qwen.
    const accepts = ['anthropic:claude-haiku-4-5', 'local-qwen:qwen3'];
    console.log(`▶ accept-list: ${JSON.stringify(accepts)}`);
    const binding = await fix.resolver.resolveBinding(accepts);
    console.log(
      `  → resolved kind=${binding.kind} provider=${binding.provider.id} model=${binding.model.id}`,
    );
    if (binding.kind === 'local') {
      console.log(`  → vendorModelId=${binding.model.vendorModelId} (passed to opencode → DMR)`);
    }
    console.log();

    // Step 2: build the adapter. localEndpoint points at DMR's
    // OpenAI-compatible chat completions endpoint. OpenCodeCliAdapter
    // will write opencode.json with this provider, then spawn
    // `opencode run --model local-qwen/ai/qwen3:0.6B-Q4_K_M ...` against it.
    console.log('▶ bindingToAdapter — constructing OpenCodeCliAdapter');
    const adapter = bindingToAdapter(binding, {
      broker: fix.broker,
      localEndpoint: () => DMR_CHAT_URL,
    });
    console.log(`  → adapter class = ${adapter.constructor.name}`);
    console.log();

    // Subscribe to adapter events for diagnostic visibility into the
    // request/response wire format. Useful to confirm what the adapter
    // actually sees vs what shows up in the returned reply.
    adapter.events.subscribe((evt) => {
      if (evt.kind === 'response') {
        console.log(`  [event] response.text length = ${(evt.text ?? '').length}`);
        if ('raw' in evt && evt.raw) {
          console.log(`  [event] response.raw = ${JSON.stringify(evt.raw).slice(0, 400)}`);
        }
      } else if (evt.kind === 'error') {
        console.log(`  [event] error: ${evt.message}`);
      }
    });

    // Step 3: actually invoke the LLM. `/no_think` is a Qwen3 control
    // token that asks the model to skip the reasoning phase and answer
    // directly — without it, qwen3:0.6B emits everything in
    // `reasoning_content` which opencode hides by default. (The 0.6B
    // model's reasoning is also slow + often empty.)
    const prompt = '/no_think Reply with exactly five words greeting an agentx developer.';
    console.log(`▶ adapter.invoke({ user: ${JSON.stringify(prompt)} })`);
    console.log('  (this spawns opencode, opencode posts to DMR, DMR runs Qwen…)');
    const t0 = Date.now();
    const reply = await adapter.invoke({
      user: prompt,
    });
    const ms = Date.now() - t0;
    console.log();
    console.log(`▶ Qwen response (${ms}ms):`);
    console.log(`  ${reply.split('\n').join('\n  ')}`);
    console.log();
    console.log('══════ ✓ REAL e2e proof complete ══════');
    console.log('  The full chain — accept-list resolution, binding, adapter,');
    console.log('  opencode spawn, DMR forwarding, qwen3 inference — ran live');
    console.log('  end-to-end. No stubs.');
  } finally {
    rmSync(fix.workspace, { recursive: true, force: true });
  }
}

main().catch((err: Error) => {
  console.error();
  console.error('e2e proof FAILED:');
  console.error(`  ${err.message}`);
  process.exit(1);
});
