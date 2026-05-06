/**
 * REAL end-to-end proof of the entry coordinator picking a pipeline via
 * live local Qwen.
 *
 * What this exercises (live, not stubbed):
 *
 *   resolved binding for local-qwen
 *     ↓
 *   bindingToAdapter → OpenCodeCliAdapter (DMR endpoint)
 *     ↓
 *   HarnessChatModel wraps the adapter as a LangChain BaseChatModel
 *     ↓
 *   runEntryCoordinator builds the coordinator graph using that model
 *     ↓
 *   Graph asks Qwen: "given this intent + these pipelines, which fits?"
 *     ↓
 *   Qwen replies with a pipeline id, graph returns the decision
 *
 * This proves the LangGraph + HarnessChatModel + coordinator chain works
 * against a real LLM. The coordinator graph itself is admin-owned per
 * memory project_langgraph_two_scopes — same code path harness-server
 * will use when slice 10c wires it into handleSubmitJob.
 *
 * Prerequisites: same as examples/14 — DMR running with
 * ai/qwen3:0.6B-Q4_K_M, opencode CLI on PATH.
 *
 * Run with:
 *   bun examples/16-entry-coordinator-with-qwen.ts
 */

import { bindingToAdapter, createHarnessChatModel } from '@agentx/agent-adapter';
import type { ResolvedBinding } from '@agentx/agent-auth-lib';
import type { Catalog } from '@agentx/harness-core';
import { runEntryCoordinator } from '@agentx/harness-server';

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
      'DMR has no qwen3 chat model. Pull with: docker model pull ai/qwen3:0.6B-Q4_K_M',
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

// Sample catalog the coordinator picks from. All agents declared with
// `opencode-cli` adapter so the demo is consistently all-Qwen-via-DMR
// — same routing layer the coordinator's own model uses. The `accepts`
// list pins each agent to the local-qwen binding too, mirroring the
// resolver chain examples/14 and examples/15 prove. (claude-sdk would
// be wrong here — it'd require Anthropic credentials we're explicitly
// not using in a local-Qwen demo.)
const sampleCatalog: Catalog = {
  pipelines: [
    {
      id: 'feature-add',
      description: 'plan, build, and review a brand-new feature end-to-end',
      agents: [
        {
          id: 'planner',
          role: 'Plan',
          adapter: 'opencode-cli',
          accepts: ['local-qwen:qwen3'],
        },
      ],
    },
    {
      id: 'bugfix-triage',
      description: 'reproduce, isolate, and fix a reported bug with tests',
      agents: [
        {
          id: 'reproducer',
          role: 'Repro',
          adapter: 'opencode-cli',
          accepts: ['local-qwen:qwen3'],
        },
      ],
    },
    {
      id: 'docs-update',
      description: 'rewrite or expand documentation files',
      agents: [
        {
          id: 'writer',
          role: 'Write',
          adapter: 'opencode-cli',
          accepts: ['local-qwen:qwen3'],
        },
      ],
    },
  ],
};

// Sample intents to route. Each is paired with the pipeline id we'd
// expect a competent router to pick — reported as ground truth alongside
// what Qwen actually says.
const intents = [
  {
    text: 'Login throws a 500 when password contains special characters',
    expected: 'bugfix-triage',
  },
  { text: 'Add dark mode to the settings panel', expected: 'feature-add' },
  {
    text: 'The README needs a quickstart section explaining the install steps',
    expected: 'docs-update',
  },
];

// Stub broker — local-qwen has authMethods=[] so no real auth is read.
const stubBroker = {
  getCredential: async () => {
    throw new Error('stub broker: no cloud credentials needed for local-qwen');
  },
};

function localQwenBinding(): ResolvedBinding {
  return {
    kind: 'local',
    provider: { id: 'local-qwen', name: 'Local Qwen', authMethods: [], models: [] },
    model: { id: 'qwen3', type: 'text', vendorModelId: 'ai/qwen3:0.6B-Q4_K_M' },
  };
}

async function main(): Promise<void> {
  console.log('agentx · entry coordinator e2e via live Qwen');
  console.log('────────────────────────────────────────────────');
  console.log('intent → coordinator graph → Qwen → pipeline decision');
  console.log();

  await preflight();

  // Build the chat model once — wraps OpenCodeCliAdapter pointed at DMR.
  // (We bypass runHarnessPipeline here because the coordinator runs in
  // harness-server's trust domain, not in a per-job container. Slice 10c
  // will wire harness-server's own opencode-server lifecycle for this.)
  const binding = localQwenBinding();
  const adapter = bindingToAdapter(binding, {
    broker: stubBroker,
    localEndpoint: () => DMR_CHAT_URL,
  });
  const model = createHarnessChatModel({
    binding,
    broker: stubBroker,
    localEndpoint: () => DMR_CHAT_URL,
  });
  void adapter;

  console.log('▶ Coordinator catalog:');
  for (const p of sampleCatalog.pipelines) {
    console.log(`  - ${p.id}: ${p.description ?? '(no description)'}`);
  }
  console.log();

  let correct = 0;
  for (const { text, expected } of intents) {
    console.log(`▶ Intent: "${text}"`);
    console.log(`  expected pipeline: ${expected}`);
    const t0 = Date.now();
    const result = await runEntryCoordinator({
      intent: text,
      catalog: sampleCatalog,
      model,
    });
    const ms = Date.now() - t0;
    const match = result.pipelineId === expected;
    if (match) correct += 1;
    console.log(`  Qwen picked:       ${result.pipelineId} ${match ? '✓' : '✗'} (${ms}ms)`);
    if (!match && result.reasoning && result.reasoning !== result.pipelineId) {
      console.log(`  reasoning excerpt: ${result.reasoning.split('\n').slice(0, 3).join(' / ')}`);
    }
    console.log();
  }

  console.log(`══════ ✓ entry coordinator e2e complete ══════`);
  console.log(`  Routing accuracy: ${correct}/${intents.length} intents matched expected pipeline`);
  console.log(`  (Qwen 0.6B is small; smarter models score higher. Architectural`);
  console.log(`  payoff is that the chain runs end-to-end — model swap is one`);
  console.log(`  binding change away.)`);
}

main().catch((err: Error) => {
  console.error();
  console.error('coordinator e2e FAILED:');
  console.error(`  ${err.message}`);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 6).join('\n'));
  process.exit(1);
});
