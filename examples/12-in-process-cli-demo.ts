import { AdapterEventBus, type AgentAdapter, type InvocationSpec } from '@ecruz165/agent-adapter';
import type { CredentialBroker } from '@ecruz165/agent-auth';
import {
  type AdapterFactory,
  type Envelope,
  findPipeline,
  JobBus,
  type JobRecord,
  type PipelineCatalog,
  runJob,
} from '@ecruz165/harness-core';

/**
 * Demo 12 — in-process CLI host using only `@ecruz165/harness-core`.
 *
 * Same outcome as demo 11 (orchestrator drives a 3-agent pipeline to
 * completion, events stream live), but with NO server in the picture:
 *   - no `startHarnessServer`
 *   - no UDS socket
 *   - no HTTP POST /v1/jobs / GET /v1/jobs/:id
 *   - no SSE client
 *
 * The CLI subscribes to the JobBus directly and calls `runJob` inline.
 * This is the form factor the harness-core extraction was for: a single-
 * process CLI that runs pipelines locally without a daemon.
 *
 * Usage:
 *   pnpm dev:in-process                              # defaults to feature-add
 *   pnpm dev:in-process feature-add "Add a button"   # explicit
 *   pnpm dev:in-process fix-bug "Repro: stack trace…"
 *
 * Trade-off vs server-mode: this process IS the worker. No per-job
 * worktree, no devcontainer override, no isolation. Two concurrent
 * `harness run` calls in the same cwd would step on each other —
 * the real CLI host should add a cwd-scoped lock; this demo doesn't.
 */

// ─── argv ─────────────────────────────────────────────────────────────────
const [pipelineId = 'feature-add', ...inputParts] = process.argv.slice(2);
const input = inputParts.length > 0 ? inputParts.join(' ') : 'Add a button';

// ─── catalog ──────────────────────────────────────────────────────────────
// In a real CLI, this would be `await loadCatalog(process.cwd())` — reading
// .harness/config/pipelines.json. Inlined here so the demo is self-contained
// and runnable without any workspace setup.
const catalog: PipelineCatalog = {
  pipelines: [
    {
      id: 'feature-add',
      agents: [
        { id: 'planner', role: 'Plan', adapter: 'claude-sdk', systemPrompt: 'Plan the work.' },
        {
          id: 'implementer',
          role: 'Implement',
          adapter: 'claude-sdk',
          systemPrompt: 'Implement the plan.',
        },
        {
          id: 'reviewer',
          role: 'Review',
          adapter: 'claude-sdk',
          systemPrompt: 'Review the changes.',
        },
      ],
    },
    {
      id: 'fix-bug',
      agents: [
        {
          id: 'diagnose',
          role: 'Diagnose',
          adapter: 'claude-sdk',
          systemPrompt: 'Diagnose the failure.',
        },
        { id: 'patch', role: 'Patch', adapter: 'claude-sdk', systemPrompt: 'Write the fix.' },
      ],
    },
  ],
};

const pipeline = findPipeline(catalog, pipelineId);
if (!pipeline) {
  console.error(`✗ pipeline "${pipelineId}" not found`);
  console.error(`  available: ${catalog.pipelines.map((p) => p.id).join(', ')}`);
  process.exit(1);
}

// ─── mock adapter + broker (no API keys needed for demo) ──────────────────
// Identical pattern to demo 11 — what's interesting here is what's NOT
// around it (no server, no UDS, no SSE), not the adapter mock itself.
class MockAdapter implements AgentAdapter {
  readonly events = new AdapterEventBus();
  constructor(private readonly reply: (user: string) => string) {}

  async invoke(spec: InvocationSpec): Promise<string> {
    this.events.emit({
      kind: 'request',
      ts: new Date().toISOString(),
      system: spec.system,
      user: spec.user,
      model: 'mock',
    });
    await new Promise((r) => setTimeout(r, 80));
    const text = this.reply(spec.user);
    this.events.emit({
      kind: 'response',
      ts: new Date().toISOString(),
      text,
    });
    return text;
  }
}

const cannedReplies: Record<string, (user: string) => string> = {
  Plan: () => '1. Pick a button name. 2. Wire onClick. 3. Add a unit test.',
  Implement: (plan) => `wrote button.tsx + button.test.tsx (plan was: "${plan.slice(0, 30)}…")`,
  Review: (impl) => `LGTM — nit: rename onClick handler. (saw: "${impl.slice(0, 30)}…")`,
  Diagnose: (repro) => `root cause: null deref in handler X (from: "${repro.slice(0, 30)}…")`,
  Patch: (diag) => `applied guard + regression test (diag: "${diag.slice(0, 30)}…")`,
};

let factoryCallIdx = 0;
const factory: AdapterFactory = () => {
  const role = pipeline.agents[factoryCallIdx++]!.role;
  const replyFn = cannedReplies[role] ?? ((u) => `(${role}) ack: ${u.slice(0, 40)}`);
  return new MockAdapter(replyFn);
};

const dummyBroker: CredentialBroker = {
  async getCredential(provider) {
    return { provider, apiKey: 'test', source: 'env' };
  },
};

// ─── build JobRecord locally (no server submit) ───────────────────────────
const jobId = `local-${Date.now()}`;
const job: JobRecord = {
  jobId,
  pipeline: pipelineId,
  status: 'received',
  submittedAt: new Date().toISOString(),
  input,
  agents: pipeline.agents.map((a) => ({ ...a, status: 'pending' as const })),
};
const jobs = new Map<string, JobRecord>([[jobId, job]]);

// ─── subscribe to bus BEFORE running so we don't miss early events ────────
const bus = new JobBus();
const seen: Envelope[] = [];
const unsubscribe = bus.subscribe(jobId, (env) => {
  seen.push(env);
  const e = env.event;
  const preview =
    e.kind === 'request'
      ? truncate(e.user, 60)
      : e.kind === 'response'
        ? truncate(e.text, 60)
        : e.kind === 'error'
          ? e.message
          : '';
  console.log(`  ← ${env.agentId.padEnd(14)} ${e.kind.padEnd(8)} ${preview}`);
});

// ─── run inline — this is the whole point ─────────────────────────────────
console.log(`▶ Running pipeline "${pipelineId}" in-process (no server)`);
console.log(`  jobId: ${jobId}`);
console.log(`  input: ${input}`);
console.log(`  agents: ${pipeline.agents.map((a) => a.id).join(' → ')}\n`);

const startedAt = Date.now();
await runJob(jobId, { jobs, bus, broker: dummyBroker, adapterFactory: factory });
const elapsedMs = Date.now() - startedAt;

unsubscribe();

// ─── final state ──────────────────────────────────────────────────────────
console.log(`\n▶ Final state: job=${job.status} (${elapsedMs}ms, ${seen.length} events)`);
for (const a of job.agents) {
  console.log(`    • ${a.id.padEnd(14)} ${a.status}`);
}

if (job.status !== 'completed') {
  process.exit(1);
}

// ─── helpers ──────────────────────────────────────────────────────────────
function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
