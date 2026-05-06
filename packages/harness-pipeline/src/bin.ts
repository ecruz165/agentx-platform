#!/usr/bin/env bun
/**
 * harness-pipeline entry binary — the executor side of the
 * assembler/executor split (`project_proxy_per_job_architecture`).
 *
 * Lifecycle:
 *   1. Read spec.json from argv[2] (or stdin if argv[2] === '-')
 *   2. Parse + validate via parseJobSpec — refuse to proceed on
 *      malformed spec (no partial-spec orchestration)
 *   3. Subscribe to a fresh JobBus BEFORE runJob fires so the first
 *      'running' transition isn't dropped (job-bus.ts:25-27)
 *   4. Stream every envelope as one JSON object per line on stdout
 *      ("line-delimited JSON" / NDJSON) — parents parse with simple
 *      `.split('\n')`, no framing protocol needed
 *   5. Run runHarnessPipeline; final line is a sentinel
 *      `{"kind":"job-complete", ...}` indicating job-level outcome
 *   6. Exit 0 (completed), 1 (failed), 2 (spec parse error), 3
 *      (runtime error before job started)
 *
 * Why JSONL on stdout: it's the simplest contract that works for
 * subprocess (9d-1, this slice) AND `devcontainer exec` (9d-2,
 * follow-up). Container's stdout is captured by `devcontainer exec`
 * verbatim, so the same parser works in both modes. Switching to
 * UDS later is a transport change, not a shape change.
 *
 * stderr is reserved for diagnostics (parse errors, panics) — the
 * parent's JSONL parser SHOULD ignore stderr, log it, and use
 * stderr-tail to populate the job-failed envelope on exit-3.
 */

import { readFile } from 'node:fs/promises';
import { JobBus } from '@agentx/harness-core';
import { runHarnessPipeline } from './index.ts';
import { type JobSpec, JobSpecError, parseJobSpec } from './spec.ts';

interface JobCompleteSentinel {
  kind: 'job-complete';
  jobId: string;
  status: string;
}

const EXIT = {
  COMPLETED: 0,
  JOB_FAILED: 1,
  SPEC_ERROR: 2,
  RUNTIME_ERROR: 3,
} as const;

async function main(): Promise<number> {
  const specPath = process.argv[2];
  if (!specPath) {
    process.stderr.write(
      'usage: harness-pipeline <spec.json>\n' +
        '       harness-pipeline -    (read spec from stdin)\n',
    );
    return EXIT.SPEC_ERROR;
  }

  let raw: string;
  try {
    raw = specPath === '-' ? await readStdin() : await readFile(specPath, 'utf8');
  } catch (err) {
    process.stderr.write(`failed to read spec from ${specPath}: ${(err as Error).message}\n`);
    return EXIT.SPEC_ERROR;
  }

  let spec: JobSpec;
  try {
    spec = parseJobSpec(JSON.parse(raw), specPath);
  } catch (err) {
    if (err instanceof JobSpecError) {
      process.stderr.write(`spec error: ${err.message}\n`);
    } else {
      process.stderr.write(`spec parse failed: ${(err as Error).message}\n`);
    }
    return EXIT.SPEC_ERROR;
  }

  // Subscribe BEFORE runHarnessPipeline calls runJob — JobBus drops
  // events when no subscriber is attached for the jobId, so an
  // attach-after-run race would lose the first 'running' transition.
  const bus = new JobBus();
  const unsub = bus.subscribe(spec.jobId, (env) => {
    // One JSON object per line, flushed immediately so the parent's
    // streaming reader sees envelopes as they happen (not on
    // process exit). process.stdout.write() doesn't buffer for pipes
    // so the immediate flush is implicit.
    process.stdout.write(`${JSON.stringify(env)}\n`);
  });

  try {
    const result = await runHarnessPipeline(spec, { bus });
    const sentinel: JobCompleteSentinel = {
      kind: 'job-complete',
      jobId: spec.jobId,
      status: result.status,
    };
    process.stdout.write(`${JSON.stringify(sentinel)}\n`);
    return result.status === 'completed' ? EXIT.COMPLETED : EXIT.JOB_FAILED;
  } catch (err) {
    process.stderr.write(`runtime error: ${(err as Error).message}\n`);
    if ((err as Error).stack) {
      process.stderr.write(`${(err as Error).stack}\n`);
    }
    return EXIT.RUNTIME_ERROR;
  } finally {
    unsub();
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`unhandled: ${(err as Error).message}\n`);
    process.exit(EXIT.RUNTIME_ERROR);
  },
);
