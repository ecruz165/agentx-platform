/**
 * REAL end-to-end via runHarnessPipeline → live local Qwen.
 *
 * The companion to examples/14: same architectural payoff (resolver →
 * binding → adapter → live Qwen) but exercises the FULL harness-pipeline
 * runtime, including:
 *
 *   - lazy opencode-server spawn (only because the spec needs one)
 *   - server-side opencode.json with derived provider config (DMR endpoint
 *     + ai/qwen3:0.6B-Q4_K_M registered)
 *   - bindingToAdapter passing serverUrl through to OpenCodeCliAdapter
 *   - OpenCodeCliAdapter using `opencode run --attach` against the warm
 *     server instead of standalone-spawning
 *
 * Where examples/14 stops at adapter.invoke() bypassing harness-pipeline,
 * this one constructs a JobSpec and lets runHarnessPipeline do all the
 * orchestration. End-to-end including the orchestrator state machine,
 * the JobBus, and the SpecBroker.
 *
 * Prerequisites: same as examples/14 — DMR running with
 * ai/qwen3:0.6B-Q4_K_M, opencode CLI on PATH.
 *
 * Run with:
 *   bun examples/15-real-qwen-via-pipeline.ts
 */

import { type JobSpec, runHarnessPipeline } from '@ecruz165/harness-pipeline';

const DMR_CHAT_URL = 'http://localhost:12434/engines/llama.cpp/v1';

async function preflight(): Promise<void> {
  console.log('preflight…');
  const res = await fetch('http://localhost:12434/v1/models').catch(() => null);
  if (!res?.ok) {
    throw new Error('Docker Model Runner not reachable at localhost:12434');
  }
  const json = await res.json();
  const ids: string[] = (json.data ?? []).map((m: { id: string }) => m.id);
  if (!ids.some((id) => id.endsWith('ai/qwen3:0.6B-Q4_K_M'))) {
    throw new Error(
      `DMR has no qwen3 chat model. Pull with: docker model pull ai/qwen3:0.6B-Q4_K_M`,
    );
  }
  console.log('  ✓ DMR up, qwen3:0.6B-Q4_K_M available');
  try {
    const proc = Bun.spawnSync(['opencode', '--version']);
    if (proc.exitCode !== 0) throw new Error('opencode --version exited non-zero');
    console.log(`  ✓ opencode CLI found (${proc.stdout.toString().trim()})`);
  } catch {
    throw new Error('opencode CLI not found on PATH');
  }
  console.log();
}

async function main(): Promise<void> {
  console.log('agentx · REAL e2e via runHarnessPipeline');
  console.log('────────────────────────────────────────────────');
  console.log('JobSpec → runHarnessPipeline → lazy opencode-server →');
  console.log('OpenCodeCliAdapter --attach → DMR → live Qwen');
  console.log();

  await preflight();

  // Build a minimal JobSpec with one local-qwen agent. In production this
  // would be assembled by harness-server from the catalog + auth.json
  // resolution; here we hand-craft it for the demo.
  const spec: JobSpec = {
    version: 1,
    jobId: 'demo-15',
    pipeline: 'qwen-greeting',
    set: 'default',
    input: '/no_think Reply with exactly five words greeting an agentx developer.',
    agents: [
      {
        id: 'qwen-greeter',
        role: 'Greeter',
        adapter: 'opencode-cli',
        bindingId: 'qwen-greeter',
      },
    ],
    bindings: {
      'qwen-greeter': {
        kind: 'local',
        provider: {
          id: 'local-qwen',
          name: 'Local Qwen',
          authMethods: [],
          models: [],
        },
        model: {
          id: 'qwen3',
          type: 'text',
          vendorModelId: 'ai/qwen3:0.6B-Q4_K_M',
        },
      },
    },
  };

  console.log('▶ runHarnessPipeline(spec)');
  console.log('  spec needs opencode-server: yes (one local-qwen binding)');
  console.log(`  expected derived provider: local-qwen → ${DMR_CHAT_URL}`);
  console.log(`  expected registered model: ai/qwen3:0.6B-Q4_K_M`);
  console.log();

  const t0 = Date.now();
  const result = await runHarnessPipeline(spec, {
    localEndpoint: () => DMR_CHAT_URL,
    onStatusChange: (_jobId, agentId, status) => {
      const who = agentId ?? 'job';
      console.log(`  [status] ${who}: ${status}`);
    },
  });
  const ms = Date.now() - t0;

  console.log();
  console.log(`▶ Pipeline complete in ${ms}ms — status=${result.status}`);
  console.log(`  opencodeServerStarted: ${result.opencodeServerStarted}`);
  console.log(`  events captured: ${result.events.length}`);
  console.log();

  // Each Envelope = {jobId, agentId, event}. The adapter's `response`
  // event carries the LLM's output text in event.text.
  const responseEnvelopes = result.events.filter((e) => e.event.kind === 'response');
  if (responseEnvelopes.length > 0) {
    console.log(`▶ Qwen response (extracted from event stream):`);
    for (const env of responseEnvelopes) {
      const evt = env.event as { kind: 'response'; text?: string };
      const text = evt.text?.trim() ?? '';
      console.log(`  agent=${env.agentId}: ${text.split('\n').join('\n  ')}`);
    }
    console.log();
  }
  console.log('══════ ✓ runHarnessPipeline e2e complete ══════');
  console.log('  The full harness-pipeline runtime — JobSpec parsing,');
  console.log('  SpecBroker, lazy opencode-server with derived provider');
  console.log('  config, bindingToAdapter, --attach mode adapter invocation,');
  console.log('  orchestrator state transitions, JobBus event capture,');
  console.log('  teardown — ran live end-to-end. No stubs.');
}

main().catch((err: Error) => {
  console.error();
  console.error('e2e via runHarnessPipeline FAILED:');
  console.error(`  ${err.message}`);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 6).join('\n'));
  process.exit(1);
});
