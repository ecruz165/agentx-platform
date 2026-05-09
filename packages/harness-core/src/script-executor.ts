/**
 * `kind: 'script'` step-kind executor.
 *
 * v1 model:
 *   - The script's `source` body lands in a temp file with the
 *     language's natural extension (`.sh` / `.mjs` / `.py`).
 *   - The interpreter (bash / node / python3) is spawned via
 *     execFile with the temp-file path as its single argument — no
 *     shell wrapper around the host invocation; the script's
 *     internal contents may use shell features at the author's
 *     discretion.
 *   - `state.output` (UTF-8 string) is piped to the child as stdin;
 *     stdout becomes the new `state.output` on success.
 *   - The full FlowState is JSON-serialized and exposed via
 *     `HARNESS_STATE_JSON` env var so scripts can pluck additional
 *     fields without parsing stdin twice.
 *   - Hard timeout (default 30s); SIGTERM on expiry, SIGKILL after a
 *     short grace if the child ignores SIGTERM.
 *
 * Trust model: scripts are admin-curated catalog content, so their
 * SOURCE is trusted. State piped via stdin / env is treated as data —
 * the executor never interpolates state into command-line args, so a
 * malicious string in state can't escape into the host shell.
 *
 * Out of v1 scope:
 *   - In-process JS sandbox (vm2 / quickjs). Scripts run as full
 *     subprocesses; cheap pure expressions belong in `transform` +
 *     jsonpath.
 *   - Memory caps. Node's child_process timeout doesn't enforce RSS
 *     limits cleanly across platforms; rely on the host OS / cgroup
 *     limits applied to the worker process when this matters.
 *   - Streaming stdout. Catalog authors who need to stream should
 *     write a `tool` (cli kind) instead — scripts are batch.
 */
import { execFile, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScriptConfig, TaskStep } from './catalog.ts';
import type { FlowStateT, NodeExecutor } from './flow-graph.ts';

const DEFAULT_TIMEOUT_MS = 30_000;
const SIGKILL_GRACE_MS = 5_000;
/** Cap stdout buffer at 10MB. Same default as the tool executor.
 *  Scripts that need streaming results should use a `tool` cli step. */
const MAX_BUFFER = 10 * 1024 * 1024;

interface InterpreterPlan {
  /** Path or PATH-resolvable name of the interpreter binary. Tests
   *  override this via env vars below for hermetic runs that don't
   *  depend on the developer machine's installed languages. */
  bin: string;
  /** File extension (with leading dot) for the temp script file.
   *  Affects only diagnostics — the interpreter is invoked
   *  positionally, not via shebang. */
  ext: string;
}

/**
 * Resolve the interpreter for a given language. Honors env-var
 * overrides so operators can point at a vendored binary (e.g.,
 * `AGENTX_NODE_BIN=/opt/node/bin/node`) without rebuilding the
 * harness. Defaults are the canonical names on POSIX systems.
 */
function pickInterpreter(language: ScriptConfig['language']): InterpreterPlan {
  const env = process.env;
  switch (language) {
    case 'bash':
      return { bin: env.AGENTX_BASH_BIN ?? '/bin/bash', ext: '.sh' };
    case 'node':
      return { bin: env.AGENTX_NODE_BIN ?? 'node', ext: '.mjs' };
    case 'python':
      return { bin: env.AGENTX_PYTHON_BIN ?? 'python3', ext: '.py' };
  }
}

/**
 * Build the per-node executor for a `kind: 'script'` TaskStep.
 *
 * Throws (config error) only when the supplied node isn't kind:
 * 'script' (programming error). Every other failure mode routes
 * through the error edge so flows can recover deterministically.
 */
export function makeScriptExecutor(node: TaskStep): NodeExecutor {
  if (node.kind !== 'script') {
    throw new Error(
      `makeScriptExecutor: node "${node.id}" has kind "${node.kind}", expected "script"`,
    );
  }
  const config = node.config as ScriptConfig;
  const nodeId = node.id;
  const plan = pickInterpreter(config.language);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (state) => {
    let workdir: string | undefined;
    try {
      workdir = await mkdtemp(join(tmpdir(), `agentx-script-${nodeId}-`));
      const scriptPath = join(workdir, `script${plan.ext}`);
      await writeFile(scriptPath, config.source, 'utf8');

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...(config.env ?? {}),
        // Per-job context. JSON-serialize the whole state so authors
        // can pluck fields without negotiating multiple stdin
        // streams. Strip very large fields if they exceed env-var
        // size limits on some platforms.
        HARNESS_JOB_ID: state.jobId,
        HARNESS_NODE_ID: nodeId,
        HARNESS_STATE_JSON: JSON.stringify(serializableStateView(state)),
      };

      return await invokeChild(nodeId, plan.bin, scriptPath, state.output, env, timeoutMs);
    } catch (err) {
      // Programming errors only land here (mkdtemp / writeFile
      // failures, missing fs primitives). Surface as a clean error
      // exit so flows can route around them.
      return {
        lastExit: {
          nodeId,
          kind: 'error',
          errorName: 'ScriptHostError',
          errorMessage: (err as Error).message,
        },
      };
    } finally {
      if (workdir) {
        // Best-effort cleanup; an EBUSY in some sandboxed FS
        // shouldn't fail the step. The caller has already gotten
        // its delta returned by this point.
        await rm(workdir, { recursive: true, force: true }).catch(() => {});
      }
    }
  };
}

/**
 * Run the interpreter against the prepared script file. Resolves to a
 * partial-state delta — never throws.
 *
 * Failure modes:
 *   - ENOENT (interpreter not on PATH) → UnknownInterpreter
 *   - SIGTERM (timeout)               → Timeout
 *   - non-zero exit                    → ScriptError (stderr in message)
 *   - native execFile error            → ScriptError (no stdout)
 */
function invokeChild(
  nodeId: string,
  bin: string,
  scriptPath: string,
  stdinValue: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<Partial<FlowStateT>> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = execFile(
        bin,
        [scriptPath],
        {
          env,
          timeout: timeoutMs,
          killSignal: 'SIGTERM',
          maxBuffer: MAX_BUFFER,
        },
        (err, stdout, stderr) => {
          const stdoutStr = stdout ?? '';
          const stderrStr = stderr ?? '';

          if (err) {
            const e = err as NodeJS.ErrnoException & { code?: string | number; signal?: string };
            if (e.code === 'ENOENT') {
              resolve({
                lastExit: {
                  nodeId,
                  kind: 'error',
                  errorName: 'UnknownInterpreter',
                  errorMessage: `${bin} not found on PATH`,
                },
              });
              return;
            }
            if (e.signal === 'SIGTERM') {
              setTimeout(() => {
                try {
                  child.kill('SIGKILL');
                } catch {
                  // process already gone
                }
              }, SIGKILL_GRACE_MS).unref();
              resolve({
                lastExit: {
                  nodeId,
                  kind: 'error',
                  errorName: 'Timeout',
                  errorMessage: `script timed out after ${timeoutMs}ms`,
                },
              });
              return;
            }
            const exitCode = typeof e.code === 'number' ? e.code : -1;
            resolve({
              lastExit: {
                nodeId,
                kind: 'error',
                errorName: 'ScriptError',
                errorMessage: `${bin} exited ${exitCode}${stderrStr ? `: ${stderrStr.trim().slice(0, 500)}` : ''}`,
              },
            });
            return;
          }

          resolve({
            output: stdoutStr,
            lastExit: { nodeId, kind: 'success' },
          });
        },
      );
    } catch (err) {
      // Synchronous spawn failures (rare — bad arg shape, FD
      // exhaustion). Same surface as ScriptHostError above.
      resolve({
        lastExit: {
          nodeId,
          kind: 'error',
          errorName: 'ScriptHostError',
          errorMessage: (err as Error).message,
        },
      });
      return;
    }

    // Pipe state.output to the child as stdin, then close. Errors
    // on stdin are swallowed — the child may exit before consuming
    // stdin (e.g., a bash script that ignores stdin), and an
    // EPIPE here shouldn't fail the step.
    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(stdinValue, 'utf8');
    }
  });
}

/**
 * Build the JSON-serializable view of state for HARNESS_STATE_JSON.
 * Excludes fields that aren't useful inside a script and keeps the
 * payload small enough to fit comfortably in env-var quotas:
 *
 *   - messages: append-only chat log; large; not typically needed
 *     in scripts.
 *   - changedFiles: file metadata; useful but verbose. Scripts
 *     that need it should use a `transform` to extract first.
 *
 * What stays:
 *   - jobId, output, attempts, lastExit, rejectionPayload, steering,
 *     cancelRequested, cancelReason — the state most scripts care
 *     about.
 */
function serializableStateView(state: FlowStateT): Record<string, unknown> {
  return {
    jobId: state.jobId,
    output: state.output,
    attempts: state.attempts,
    lastExit: state.lastExit,
    rejectionPayload: state.rejectionPayload,
    steering: state.steering,
    cancelRequested: state.cancelRequested,
    cancelReason: state.cancelReason,
  };
}
