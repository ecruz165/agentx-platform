/** @jsxImportSource @opentui/react */
import { useEffect, useState } from 'react';
import { createCliRenderer } from '@opentui/core';
import { createRoot, useKeyboard } from '@opentui/react';
import {
  AdapterEventBus,
  type AgentAdapter,
  type InvocationSpec,
} from '@agentx/agent-adapter';
import type { CredentialBroker } from '@agentx/agent-auth-lib';
import {
  JobBus,
  findPipeline,
  resolveAccepts,
  runJob,
  type AdapterFactory,
  type Envelope,
  type JobRecord,
  type PipelineCatalog,
} from '@agentx/harness-core';

/**
 * In-process `harness run <pipeline> [input]` — Bun + OpenTUI demo surface.
 *
 * What this validates: the harness-core extraction works as a real consumer
 * surface, not just a script. No UDS daemon, no HTTP, no SSE. The CLI:
 *   1. loads a catalog (inlined here; real CLI would call loadCatalog)
 *   2. picks a pipeline by id from argv
 *   3. constructs JobBus + JobRecord locally
 *   4. subscribes to the bus and renders events live via OpenTUI
 *   5. calls runJob inline
 *   6. shows final state; press q (or Enter/Esc) to exit
 *
 * Requires Bun (OpenTUI core depends on bun-ffi-structs).
 *   bun packages/harness-cli/src/in-process-run.tsx [pipeline] [input...]
 *   pnpm harness:run feature-add "Add a button"
 *
 * v1 limitation: mock adapter (same as example 12) so it runs without API
 * keys. The real adapter wiring lands when this surface graduates from demo
 * to a real `harness run` subcommand.
 */

// ─── argv ─────────────────────────────────────────────────────────────────
const [pipelineId = 'feature-add', ...inputParts] = process.argv.slice(2);
const input = inputParts.length > 0 ? inputParts.join(' ') : 'Add a button';

// ─── catalog ──────────────────────────────────────────────────────────────
const catalog: PipelineCatalog = {
  pipelines: [
    {
      id: 'feature-add',
      agents: [
        { id: 'planner', role: 'Plan', adapter: 'claude-sdk', systemPrompt: 'Plan the work.' },
        { id: 'implementer', role: 'Implement', adapter: 'claude-sdk', systemPrompt: 'Implement the plan.' },
        { id: 'reviewer', role: 'Review', adapter: 'claude-sdk', systemPrompt: 'Review the changes.' },
      ],
    },
    {
      id: 'fix-bug',
      agents: [
        { id: 'diagnose', role: 'Diagnose', adapter: 'claude-sdk', systemPrompt: 'Diagnose the failure.' },
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

// ─── mock adapter + broker (no API keys for demo) ─────────────────────────
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
    await new Promise((r) => setTimeout(r, 250));
    const text = this.reply(spec.user);
    this.events.emit({ kind: 'response', ts: new Date().toISOString(), text });
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

// ─── job state (lives outside React; orchestrator mutates in place) ───────
const jobId = `local-${Date.now()}`;
const initialJob: JobRecord = {
  jobId,
  pipeline: pipelineId,
  status: 'received',
  submittedAt: new Date().toISOString(),
  input,
  agents: pipeline.agents.map((a) => ({
    ...a,
    accepts: resolveAccepts(a, 'default'),
    status: 'pending' as const,
  })),
};
const jobs = new Map<string, JobRecord>([[jobId, initialJob]]);
const bus = new JobBus();

// ─── helpers ──────────────────────────────────────────────────────────────
function statusIcon(status: string): string {
  switch (status) {
    case 'pending': return '○';
    case 'running': return '◐';
    case 'completed': return '●';
    case 'failed': return '✗';
    default: return '?';
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'completed': return '#4ade80'; // green
    case 'running': return '#facc15'; // yellow
    case 'failed': return '#f87171'; // red
    default: return '#9ca3af'; // gray
  }
}

function eventPreview(env: Envelope): string {
  const e = env.event;
  switch (e.kind) {
    case 'request': return e.user.slice(0, 80);
    case 'response': return e.text.slice(0, 80);
    case 'error': return e.message;
    case 'loader-event':
      return `[${e.innerKind}] files=${e.counts.files} chunks=${e.counts.chunks} vectors=${e.counts.vectors}`;
  }
}

// ─── React app ────────────────────────────────────────────────────────────
function App() {
  const [events, setEvents] = useState<Envelope[]>([]);
  const [job, setJob] = useState<JobRecord>(initialJob);
  const [done, setDone] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const unsub = bus.subscribe(jobId, (env) => {
      setEvents((prev) => [...prev, env]);
      // The orchestrator mutates job state in place. Trigger a re-render by
      // creating a new JobRecord reference holding the same (now-updated)
      // agent objects.
      setJob({ ...jobs.get(jobId)! });
    });

    runJob(jobId, { jobs, bus, broker: dummyBroker, adapterFactory: factory })
      .then(() => {
        setJob({ ...jobs.get(jobId)! });
        setElapsedMs(Date.now() - startedAt);
        setDone(true);
      })
      .catch((err) => {
        // runJob handles its own errors; this catches anything truly unexpected.
        bus.publish(jobId, 'orchestrator', {
          kind: 'error',
          ts: new Date().toISOString(),
          message: `unexpected: ${(err as Error).message}`,
        });
        setElapsedMs(Date.now() - startedAt);
        setDone(true);
      });

    return unsub;
  }, []);

  useKeyboard((e) => {
    if (!done) return;
    if (e.name === 'q' || e.name === 'return' || e.name === 'escape') {
      process.exit(job.status === 'completed' ? 0 : 1);
    }
  });

  return (
    <box flexDirection="column" padding={1}>
      <text>
        <span fg="#60a5fa">▶ Pipeline: </span>
        <span fg="#f3f4f6">{pipelineId}</span>
        <span fg="#60a5fa"> · jobId: </span>
        <span fg="#9ca3af">{jobId}</span>
      </text>
      <text fg="#9ca3af">  Input: {input}</text>
      <text> </text>
      <box flexDirection="row" flexGrow={1}>
        <box
          flexDirection="column"
          width={32}
          border
          title="Agents"
          padding={1}
        >
          {job.agents.map((a) => (
            <text key={a.id} fg={statusColor(a.status)}>
              {statusIcon(a.status)} {a.id.padEnd(14)} {a.status}
            </text>
          ))}
        </box>
        <scrollbox flexGrow={1} border title="Events" padding={1}>
          {events.length === 0 ? (
            <text fg="#6b7280">(waiting for events…)</text>
          ) : (
            events.map((env, i) => (
              <text key={i}>
                <span fg="#9ca3af">{env.agentId.padEnd(14)}</span>
                <span> </span>
                <span fg={env.event.kind === 'error' ? '#f87171' : '#a78bfa'}>{env.event.kind.padEnd(8)}</span>
                <span> </span>
                <span fg="#e5e7eb">{eventPreview(env)}</span>
              </text>
            ))
          )}
        </scrollbox>
      </box>
      <text> </text>
      <text>
        <span fg={done ? statusColor(job.status) : '#facc15'}>
          {done ? statusIcon(job.status) : '◐'} {job.status}
        </span>
        <span fg="#9ca3af"> · {events.length} events{done ? ` · ${elapsedMs}ms · press q to exit` : ''}</span>
      </text>
    </box>
  );
}

// ─── bootstrap ────────────────────────────────────────────────────────────
const renderer = await createCliRenderer({
  exitOnCtrlC: true,
});
createRoot(renderer).render(<App />);
