/**
 * Idle throttle (PRD F9) — daemon transitions to 'idle' after 10min
 * with no traffic on /v1/* routes; first request after idle re-warms.
 *
 * Why a state-machine + hooks (not "close the DB on idle"):
 *   v1's SqliteVecMemoryStore uses better-sqlite3 with a single
 *   long-lived connection. Closing + reopening on every cycle is
 *   invasive (lose prepared statements, reload extension, WAL
 *   checkpoint races). The PRD's "drop embeddings model from RAM"
 *   isn't a v1 concern either — our embedder is a remote HTTP service.
 *
 *   v1 ships the OBSERVABLE half (state, /health surfaces it,
 *   /metrics gauge tracks it) and gives callers onIdle / onWarm
 *   hooks. Production wiring can drop embedder dispatchers in
 *   onIdle without touching the SQLite layer. v1.x may close DB
 *   connections if RSS measurements show it matters.
 *
 * Activity is recorded by the route layer for /v1/* paths only —
 * /health and /metrics scrapes shouldn't keep a quiet daemon warm.
 */

export type IdleState = 'warm' | 'idle';

export interface IdleThrottleOptions {
  /** Time-since-last-activity that flips warm→idle. Default 600_000 (10min). */
  idleTimeoutMs?: number;
  /** How often the periodic check runs. Default 30_000 (30s). */
  checkIntervalMs?: number;
  /** Called on warm→idle transition. Errors keep state in 'warm'. */
  onIdle?: () => Promise<void>;
  /** Called on idle→warm transition. Awaited before route handler
   *  runs — first-call-after-idle pays this cost. */
  onWarm?: () => Promise<void>;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
  /** Logger for transition errors. Defaults to console.warn. */
  warn?: (msg: string) => void;
}

export class IdleThrottle {
  private _state: IdleState = 'warm';
  private lastActivity: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private warmInFlight: Promise<void> | undefined;

  private readonly idleTimeoutMs: number;
  private readonly checkIntervalMs: number;
  private readonly onIdle: () => Promise<void>;
  private readonly onWarm: () => Promise<void>;
  private readonly now: () => number;
  private readonly warn: (msg: string) => void;

  constructor(opts: IdleThrottleOptions = {}) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 600_000;
    this.checkIntervalMs = opts.checkIntervalMs ?? 30_000;
    this.onIdle = opts.onIdle ?? (() => Promise.resolve());
    this.onWarm = opts.onWarm ?? (() => Promise.resolve());
    this.now = opts.now ?? (() => Date.now());
    this.warn = opts.warn ?? ((m) => console.warn(`[idle-throttle] ${m}`));
    this.lastActivity = this.now();
  }

  get state(): IdleState {
    return this._state;
  }

  recordActivity(): void {
    this.lastActivity = this.now();
  }

  /** If idle, run onWarm and flip to warm. Concurrent callers share
   *  one warmup promise (no double-warm). */
  async ensureWarm(): Promise<void> {
    if (this._state === 'warm') return;
    if (this.warmInFlight) {
      await this.warmInFlight;
      return;
    }
    this.warmInFlight = (async () => {
      try {
        await this.onWarm();
        this._state = 'warm';
        this.lastActivity = this.now();
      } finally {
        this.warmInFlight = undefined;
      }
    })();
    try {
      await this.warmInFlight;
    } catch (err) {
      this.warn(`onWarm failed: ${(err as Error).message}`);
      throw err;
    }
  }

  /** Periodic check exposed for tests; production schedules via start(). */
  async checkIdle(): Promise<void> {
    if (this._state !== 'warm') return;
    if (this.now() - this.lastActivity < this.idleTimeoutMs) return;
    try {
      await this.onIdle();
      this._state = 'idle';
    } catch (err) {
      this.warn(`onIdle failed: ${(err as Error).message}`);
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.checkIdle();
    }, this.checkIntervalMs);
    if (typeof (this.timer as { unref?: () => void }).unref === 'function') {
      (this.timer as { unref: () => void }).unref();
    }
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
