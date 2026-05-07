/**
 * REAL end-to-end proof of the entry coordinator picking a pipeline via
 * GitHub Copilot (device-token auth → live LLM call).
 *
 * Companion to examples/16 (which uses local-Qwen-via-DMR). Same chain
 * — accept-list → resolver → bindingToAdapter → adapter → model →
 * coordinator graph — but with Copilot's hosted models (gpt-4o,
 * claude-3-5-sonnet, gemini-1.5-pro) instead of local Qwen. Unlike the
 * direct Anthropic / OpenAI paths, Copilot gives you frontier models
 * via a single device-code OAuth login — no API keys to manage.
 *
 * What this exercises (live, not stubbed):
 *
 *   ~/.agentx/auth.json (populated by `harness auth login github-copilot`)
 *     ↓ FileBroker / AuthStore
 *   github-copilot:gpt-4o binding
 *     ↓ bindingToAdapter (with copilotAuthPath)
 *   CopilotChatAdapter
 *     ↓ getCopilotSessionToken (cached → refresh → exchange OAuth)
 *   POST api.githubcopilot.com/chat/completions
 *     ↓
 *   GPT-4o response
 *     ↓ HarnessChatModel
 *   LangGraph coordinator routes the intent
 *
 * Prerequisites:
 *   1. `pnpm harness auth login github-copilot` (one-time device-code flow)
 *   2. `pnpm harness auth status` shows ✓ github-copilot
 *
 * Run with:
 *   bun examples/17-copilot-coordinator.ts
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHarnessChatModel } from '@ecruz165/agent-adapter';
import type { CredentialBroker, ResolvedBinding } from '@ecruz165/agent-auth';
import type { Catalog } from '@ecruz165/harness-core';
import { runEntryCoordinator } from '@ecruz165/harness-server';

const AUTH_PATH = join(homedir(), '.agentx', 'auth.json');

// Copilot model id — pick one that's cheap-and-fast for routing.
// Other valid values include 'claude-3-5-sonnet', 'gemini-1.5-pro'.
const COPILOT_MODEL = 'gpt-4o';

// Sample catalog — same shape as examples/16. Each pipeline could
// declare its own `accepts` list, but for this demo we only exercise
// the coordinator's pipeline-pick decision.
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
          accepts: ['github-copilot:gpt-4o'],
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
          accepts: ['github-copilot:gpt-4o'],
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
          accepts: ['github-copilot:gpt-4o'],
        },
      ],
    },
    {
      id: 'security-audit',
      description: 'scan code for vulnerabilities and propose remediations',
      agents: [
        {
          id: 'auditor',
          role: 'Audit',
          adapter: 'opencode-cli',
          accepts: ['github-copilot:gpt-4o'],
        },
      ],
    },
  ],
};

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
  {
    text: 'Check whether our JWT signing routine has any timing-attack vulnerabilities',
    expected: 'security-audit',
  },
];

// Stub broker — Copilot's adapter reads auth.json directly via authPath,
// so a broker stub that throws is fine (it never gets called).
const stubBroker: CredentialBroker = {
  getCredential: async () => {
    throw new Error('stub: CopilotChatAdapter reads auth.json directly via copilotAuthPath');
  },
};

function copilotBinding(model: string): ResolvedBinding {
  return {
    kind: 'cloud',
    provider: {
      id: 'github-copilot',
      name: 'GitHub Copilot',
      authMethods: ['device-code'],
      models: [],
    },
    model: { id: model, type: 'text' },
    // The credential is unused by CopilotChatAdapter (which reads
    // auth.json directly via authPath) but the type requires one.
    credential: {
      provider: 'github-copilot',
      apiKey: '(unused; Copilot reads from authPath)',
      source: 'host-file',
    },
  };
}

async function preflight(): Promise<void> {
  console.log('preflight…');

  if (!existsSync(AUTH_PATH)) {
    throw new Error(
      `auth.json not found at ${AUTH_PATH}\nRun: pnpm harness auth login github-copilot`,
    );
  }

  let parsed: { providers?: Record<string, { apiKey?: string; username?: string }> };
  try {
    parsed = JSON.parse(readFileSync(AUTH_PATH, 'utf8'));
  } catch (err) {
    throw new Error(`auth.json is malformed: ${(err as Error).message}`);
  }
  const cred = parsed.providers?.['github-copilot'];
  if (!cred?.apiKey || cred.apiKey.includes('REPLACE_ME')) {
    throw new Error(
      `github-copilot not authenticated.\n` + `Run: pnpm harness auth login github-copilot`,
    );
  }
  console.log(`  ✓ github-copilot authenticated${cred.username ? ` as @${cred.username}` : ''}`);
  console.log();
}

async function main(): Promise<void> {
  console.log('agentx · entry coordinator e2e via GitHub Copilot');
  console.log('────────────────────────────────────────────────────');
  console.log('intent → coordinator graph → Copilot (gpt-4o) → pipeline decision');
  console.log();

  await preflight();

  const model = createHarnessChatModel({
    binding: copilotBinding(COPILOT_MODEL),
    broker: stubBroker,
    copilotAuthPath: AUTH_PATH,
  });

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
    console.log(`  Copilot picked:    ${result.pipelineId} ${match ? '✓' : '✗'} (${ms}ms)`);
    if (!match) {
      console.log(
        `  reasoning:         ${result.reasoning.split('\n').slice(0, 2).join(' / ').slice(0, 200)}`,
      );
    }
    console.log();
  }

  console.log(`══════ ✓ entry coordinator e2e complete ══════`);
  console.log(`  Routing accuracy: ${correct}/${intents.length} intents matched expected pipeline`);
  console.log(`  Model: ${COPILOT_MODEL} via GitHub Copilot (device-token auth, no API key)`);
  console.log();
  console.log(`  Architectural payoff: same coordinator graph, same HarnessChatModel`);
  console.log(`  wrapper, same accept-list resolver — only the binding differs from`);
  console.log(`  examples/16 (local-qwen). Frontier model swap = one binding change.`);
}

main().catch((err: Error) => {
  console.error();
  console.error('coordinator e2e FAILED:');
  console.error(`  ${err.message}`);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 6).join('\n'));
  process.exit(1);
});
