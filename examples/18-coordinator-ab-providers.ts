/**
 * A/B compare entry-coordinator routing accuracy across providers.
 *
 * Runs the SAME intents through the SAME coordinator graph but with
 * different bindings — so the only variable is the model. Today's
 * configurable providers:
 *
 *   - github-copilot:gpt-4o     (Copilot's GPT-4o, device-token auth)
 *   - openai:gpt-4o             (direct OpenAI, API key auth)
 *
 * Both use the same `gpt-4o` underneath but go through different
 * auth/billing/serving paths — Copilot adds its routing layer; direct
 * OpenAI is the raw API. Comparing them on the same intents tells
 * you which path to prefer for production routing.
 *
 * Architectural payoff (per memory project_per_worker_model_subscription):
 * the binding is the only line that changes between A and B. Same
 * graph, same resolver, same adapter dispatch — just a different
 * `<provider>:<model>` pair.
 *
 * Run with:
 *   bun examples/18-coordinator-ab-providers.ts
 *
 * To skip a provider (if you don't have it configured):
 *   AGENTX_AB_PROVIDERS=copilot bun examples/18-...
 *   AGENTX_AB_PROVIDERS=openai bun examples/18-...
 *   (default: both)
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type CopilotChatAdapterOptions, createHarnessChatModel } from '@agentx/agent-adapter';
import { type CredentialBroker, FileBroker, type ResolvedBinding } from '@agentx/agent-auth-lib';
import type { Catalog } from '@agentx/harness-core';
import { runEntryCoordinator } from '@agentx/harness-server';

const AUTH_PATH = join(homedir(), '.agentx', 'auth.json');
const PROVIDERS_RAW = process.env.AGENTX_AB_PROVIDERS ?? 'copilot,openai';
const PROVIDERS = PROVIDERS_RAW.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Same catalog as examples/17 + 16 — keeps cross-demo comparability.
const sampleCatalog: Catalog = {
  pipelines: [
    {
      id: 'feature-add',
      description: 'plan, build, and review a brand-new feature end-to-end',
      agents: [{ id: 'planner', role: 'Plan', adapter: 'opencode-cli' }],
    },
    {
      id: 'bugfix-triage',
      description: 'reproduce, isolate, and fix a reported bug with tests',
      agents: [{ id: 'reproducer', role: 'Repro', adapter: 'opencode-cli' }],
    },
    {
      id: 'docs-update',
      description: 'rewrite or expand documentation files',
      agents: [{ id: 'writer', role: 'Write', adapter: 'opencode-cli' }],
    },
    {
      id: 'security-audit',
      description: 'scan code for vulnerabilities and propose remediations',
      agents: [{ id: 'auditor', role: 'Audit', adapter: 'opencode-cli' }],
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

// ─── binding builders ─────────────────────────────────────────────────────

function copilotBinding(): ResolvedBinding {
  return {
    kind: 'cloud',
    provider: {
      id: 'github-copilot',
      name: 'GitHub Copilot',
      authMethods: ['device-code'],
      models: [],
    },
    model: { id: 'gpt-4o', type: 'text' },
    credential: {
      provider: 'github-copilot',
      apiKey: '(unused; Copilot reads from authPath)',
      source: 'host-file',
    },
  };
}

function openaiBinding(apiKey: string): ResolvedBinding {
  return {
    kind: 'cloud',
    provider: { id: 'openai', name: 'OpenAI', authMethods: ['api-key'], models: [] },
    model: { id: 'gpt-4o', type: 'text' },
    credential: {
      provider: 'openai',
      apiKey,
      source: 'host-file',
    },
  };
}

// Stub broker for the Copilot path (CopilotChatAdapter reads authPath).
const stubBroker: CredentialBroker = {
  getCredential: async () => {
    throw new Error('stub: Copilot reads auth.json directly via authPath');
  },
};

// ─── per-provider runner ──────────────────────────────────────────────────

interface ProviderResult {
  provider: string;
  modelLabel: string;
  results: Array<{
    intent: string;
    expected: string;
    picked: string;
    ms: number;
    correct: boolean;
  }>;
}

async function runProvider(name: string): Promise<ProviderResult | null> {
  console.log(`▶ Provider: ${name}`);

  let model: ReturnType<typeof createHarnessChatModel>;
  let modelLabel: string;

  if (name === 'copilot') {
    if (!authHasProvider('github-copilot')) {
      console.log(
        `  ✗ skipped — github-copilot not in auth.json (run: harness auth login github-copilot)\n`,
      );
      return null;
    }
    modelLabel = 'github-copilot:gpt-4o (Copilot-routed)';
    model = createHarnessChatModel({
      binding: copilotBinding(),
      broker: stubBroker,
      copilotAuthPath: AUTH_PATH,
    });
  } else if (name === 'openai') {
    const apiKey = readApiKey('openai');
    if (!apiKey) {
      console.log(`  ✗ skipped — openai not in auth.json (or placeholder credential)\n`);
      return null;
    }
    modelLabel = 'openai:gpt-4o (direct OpenAI API)';
    // Real FileBroker so OpenCodeCliAdapter (which the openai binding
    // routes to) can pull the credential at invoke time.
    const broker = new FileBroker(AUTH_PATH);
    model = createHarnessChatModel({
      binding: openaiBinding(apiKey),
      broker,
    });
  } else {
    console.log(`  ✗ unknown provider name: ${name}\n`);
    return null;
  }

  console.log(`  model: ${modelLabel}`);
  const results: ProviderResult['results'] = [];
  for (const { text, expected } of intents) {
    const t0 = Date.now();
    let picked: string;
    try {
      const r = await runEntryCoordinator({ intent: text, catalog: sampleCatalog, model });
      picked = r.pipelineId;
    } catch (err) {
      picked = `<ERROR: ${(err as Error).message.slice(0, 60)}>`;
    }
    const ms = Date.now() - t0;
    const correct = picked === expected;
    results.push({ intent: text, expected, picked, ms, correct });
    console.log(
      `    [${correct ? '✓' : '✗'}] ${truncate(text, 60).padEnd(62)} → ${picked.padEnd(20)} (${ms}ms)`,
    );
  }
  console.log();
  return { provider: name, modelLabel, results };
}

// ─── helpers ──────────────────────────────────────────────────────────────

function readAuthFile(): { providers?: Record<string, { apiKey?: string }> } {
  if (!existsSync(AUTH_PATH)) {
    throw new Error(`auth.json not found at ${AUTH_PATH}`);
  }
  return JSON.parse(readFileSync(AUTH_PATH, 'utf8'));
}

function authHasProvider(id: string): boolean {
  try {
    const file = readAuthFile();
    const cred = file.providers?.[id];
    return !!cred?.apiKey && !cred.apiKey.includes('REPLACE_ME');
  } catch {
    return false;
  }
}

function readApiKey(id: string): string | null {
  try {
    const cred = readAuthFile().providers?.[id];
    if (!cred?.apiKey || cred.apiKey.includes('REPLACE_ME')) return null;
    return cred.apiKey;
  } catch {
    return null;
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

void {} as CopilotChatAdapterOptions; // type ref to keep import alive when checking

// ─── main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('agentx · entry coordinator A/B across providers');
  console.log('────────────────────────────────────────────────────');
  console.log(`Comparing: ${PROVIDERS.join(' vs ')}`);
  console.log(`Catalog: ${sampleCatalog.pipelines.length} pipelines, ${intents.length} intents`);
  console.log();

  const allResults: ProviderResult[] = [];
  for (const p of PROVIDERS) {
    const r = await runProvider(p);
    if (r) allResults.push(r);
  }

  if (allResults.length === 0) {
    console.log('No providers ran. Check ~/.agentx/auth.json.');
    process.exit(1);
  }

  console.log('══════ summary ══════');
  console.log();
  for (const r of allResults) {
    const correct = r.results.filter((x) => x.correct).length;
    const total = r.results.length;
    const avgMs = Math.round(r.results.reduce((a, x) => a + x.ms, 0) / total);
    console.log(`  ${r.modelLabel}`);
    console.log(`    accuracy: ${correct}/${total}    avg latency: ${avgMs}ms`);
    console.log();
  }

  if (allResults.length >= 2) {
    console.log('  per-intent verdict (rows = intents, cols = providers):');
    console.log();
    const headers = allResults.map((r) => r.provider.padEnd(10));
    console.log(`    ${'intent'.padEnd(60)}  ${headers.join(' ')}`);
    for (let i = 0; i < intents.length; i++) {
      const intentText = truncate(intents[i]!.text, 60).padEnd(60);
      const cells = allResults.map((r) => {
        const cell = r.results[i]!;
        return (cell.correct ? '✓' : '✗').padEnd(10);
      });
      console.log(`    ${intentText}  ${cells.join(' ')}`);
    }
    console.log();
  }

  console.log('══════ ✓ A/B run complete ══════');
}

main().catch((err: Error) => {
  console.error();
  console.error('A/B run FAILED:');
  console.error(`  ${err.message}`);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 6).join('\n'));
  process.exit(1);
});
