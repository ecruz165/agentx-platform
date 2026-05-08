/**
 * Minimal in-process cron (PRD F7).
 *
 * Supports the standard 5-field cron expression: `min hour dom mon dow`.
 * Each field accepts numbers, ranges (`1-5`), lists (`1,3,5`), step
 * (`*\/15`), and `*` wildcard. Day-of-week 0-6 (Sunday=0) — same
 * convention as crontab(5). No second-level granularity, no special
 * strings (@daily, @hourly) — operators write explicit expressions.
 *
 * Fires its registered tasks on a setTimeout schedule that aligns to
 * the next matching minute boundary. Cancel via `stop()`.
 *
 * Why hand-rolled: PRD asks for cron expressions; `node-cron` has 4M+
 * downloads but adds 50KB of deps for what's a 70-line parser when you
 * scope to "v1 minimum viable." We can replace with node-cron later
 * if the parser sprouts edge cases.
 */

export type CronTask = () => void | Promise<void>;

export interface ScheduledJob {
  /** Cron expression — 5 fields separated by whitespace. */
  expression: string;
  /** Caller-meaningful name — appears in metrics + logs. */
  name: string;
  /** What to fire. Errors are caught + logged so a bad job doesn't
   *  prevent future fires. */
  task: CronTask;
}

export interface CronSchedulerOptions {
  /** Inject a clock for tests — defaults to Date.now(). */
  now?: () => number;
  /** Inject setTimeout for tests — must accept a delay in ms. */
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export class CronScheduler {
  private readonly jobs: Array<ScheduledJob & { parsed: ParsedCron; nextHandle?: unknown }> = [];
  private running = false;
  private readonly nowFn: () => number;
  private readonly setTimeoutFn: (cb: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;

  constructor(opts: CronSchedulerOptions = {}) {
    this.nowFn = opts.now ?? (() => Date.now());
    this.setTimeoutFn = opts.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimeoutFn = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Register a job. Throws if the expression is malformed. Idempotent
   *  per-name: re-registering replaces. */
  add(job: ScheduledJob): void {
    const parsed = parseCron(job.expression);
    // Replace existing
    const existing = this.jobs.findIndex((j) => j.name === job.name);
    if (existing >= 0) {
      const old = this.jobs[existing]!;
      if (old.nextHandle) this.clearTimeoutFn(old.nextHandle);
      this.jobs.splice(existing, 1);
    }
    const entry = { ...job, parsed };
    this.jobs.push(entry);
    if (this.running) this.scheduleNext(entry);
  }

  /** Remove a job by name. Returns true if a job was removed. */
  remove(name: string): boolean {
    const idx = this.jobs.findIndex((j) => j.name === name);
    if (idx < 0) return false;
    const job = this.jobs[idx]!;
    if (job.nextHandle) this.clearTimeoutFn(job.nextHandle);
    this.jobs.splice(idx, 1);
    return true;
  }

  /** Begin scheduling all registered jobs. */
  start(): void {
    if (this.running) return;
    this.running = true;
    for (const job of this.jobs) this.scheduleNext(job);
  }

  /** Cancel all timers + stop. Safe to call multiple times. */
  stop(): void {
    this.running = false;
    for (const job of this.jobs) {
      if (job.nextHandle) {
        this.clearTimeoutFn(job.nextHandle);
        job.nextHandle = undefined;
      }
    }
  }

  /** Names of registered jobs — exposed for diagnostics. */
  list(): string[] {
    return this.jobs.map((j) => j.name);
  }

  private scheduleNext(job: ScheduledJob & { parsed: ParsedCron; nextHandle?: unknown }): void {
    if (!this.running) return;
    const now = this.nowFn();
    const next = nextFireTime(job.parsed, now);
    const delay = Math.max(0, next - now);
    job.nextHandle = this.setTimeoutFn(() => {
      void Promise.resolve()
        .then(() => job.task())
        .catch((err: Error) => {
          process.stderr.write(
            `[cron] job '${job.name}' failed: ${err.message}\n`,
          );
        })
        .finally(() => {
          this.scheduleNext(job);
        });
    }, delay);
  }
}

// ─── parser ───────────────────────────────────────────────────────────

export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
}

export function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron expression must have 5 fields, got ${parts.length}: '${expr}'`);
  }
  return {
    minute: parseField(parts[0]!, 0, 59),
    hour: parseField(parts[1]!, 0, 23),
    dom: parseField(parts[2]!, 1, 31),
    month: parseField(parts[3]!, 1, 12),
    dow: parseField(parts[4]!, 0, 6),
  };
}

function parseField(field: string, lo: number, hi: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    let body = part;
    let step = 1;
    const stepIdx = body.indexOf('/');
    if (stepIdx >= 0) {
      const stepStr = body.slice(stepIdx + 1);
      step = Number.parseInt(stepStr, 10);
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error(`invalid step in cron field: ${part}`);
      }
      body = body.slice(0, stepIdx);
    }
    let from: number;
    let to: number;
    if (body === '*' || body === '') {
      from = lo;
      to = hi;
    } else if (body.includes('-')) {
      const [a, b] = body.split('-');
      from = Number.parseInt(a ?? '', 10);
      to = Number.parseInt(b ?? '', 10);
      if (!Number.isInteger(from) || !Number.isInteger(to)) {
        throw new Error(`invalid range in cron field: ${part}`);
      }
    } else {
      from = Number.parseInt(body, 10);
      to = from;
      if (!Number.isInteger(from)) throw new Error(`invalid value in cron field: ${part}`);
    }
    if (from < lo || to > hi || from > to) {
      throw new Error(`cron field out of range [${lo}, ${hi}]: ${part}`);
    }
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

/**
 * Compute the next ms timestamp at or after `nowMs` that matches the
 * parsed expression. Ticks forward minute-by-minute up to a 4-year
 * horizon to bound runaway loops. Worst case is ~minutes of work for
 * pathological expressions; in practice resolves in microseconds.
 */
export function nextFireTime(parsed: ParsedCron, nowMs: number): number {
  const date = new Date(nowMs);
  // Round up to the next minute boundary.
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);

  const horizon = nowMs + 4 * 365 * 24 * 60 * 60 * 1000;
  while (date.getTime() < horizon) {
    if (
      parsed.minute.has(date.getMinutes()) &&
      parsed.hour.has(date.getHours()) &&
      parsed.dom.has(date.getDate()) &&
      parsed.month.has(date.getMonth() + 1) &&
      parsed.dow.has(date.getDay())
    ) {
      return date.getTime();
    }
    date.setMinutes(date.getMinutes() + 1);
  }
  throw new Error('cron expression has no fire time within 4-year horizon');
}

export const __test__ = { parseField };
