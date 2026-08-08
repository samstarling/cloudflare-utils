import { DebounceAndLease } from "@samstarling/cloudflare-utils-debounce";
import type { ExampleRun } from "./shared";

// The library reserves the "__dbl:" storage key prefix, so everything this subclass persists is
// namespaced under its own prefix to stay clear of it.
const RUNS_KEY = "example:runs";
const LAST_RUN_AT_KEY = "example:lastRunAt";
const MAX_RUNS = 20;

export class ExampleDebounceAndLease extends DebounceAndLease<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, {
      quietPeriodMs: 5_000,
      // Without this, holding down "Send signal" pushes the deadline out forever and run() never
      // fires at all. 20s puts a visible ceiling on it: keep signalling and it runs anyway.
      maxWaitMs: 20_000,
      leaseDurationMs: 5_000,
      onRunError: (error, key) => console.error(`run() failed for key "${key}":`, error),
    });
  }

  /** Most-recent-first run history, for the dashboard's activity log. */
  async runs(): Promise<ExampleRun[]> {
    return this.readRuns();
  }

  protected async run(key: string, epoch: number): Promise<void> {
    const durationMs = Math.random() * 10_000;
    console.log(
      `[ExampleDebounceAndLease] running action for key "${key}" (${Math.round(durationMs)}ms)`,
    );
    this.recordRunStart(epoch);

    await new Promise((resolve) => setTimeout(resolve, durationMs));

    // This can run longer than leaseDurationMs, so it can genuinely be superseded by a reclaim
    // before it finishes — check before the side effect rather than let a stale write win.
    if (!this.isCurrentEpoch(epoch)) {
      console.log(`[ExampleDebounceAndLease] epoch ${epoch} for key "${key}" was superseded`);
      this.recordRunEnd(epoch, "superseded");
      return;
    }
    this.ctx.storage.kv.put(LAST_RUN_AT_KEY, Date.now());
    console.log(`[ExampleDebounceAndLease] finished action for key "${key}" (epoch ${epoch})`);
    this.recordRunEnd(epoch, "completed");
  }

  private readRuns(): ExampleRun[] {
    return this.ctx.storage.kv.get<ExampleRun[]>(RUNS_KEY) ?? [];
  }

  private recordRunStart(epoch: number): void {
    const runs: ExampleRun[] = [{ epoch, startedAt: Date.now() }, ...this.readRuns()];
    this.ctx.storage.kv.put(RUNS_KEY, runs.slice(0, MAX_RUNS));
  }

  // Re-reads rather than closing over the array recordRunStart wrote: a superseded run finishes
  // while a newer epoch is already in flight, so the history has moved on since it started.
  private recordRunEnd(epoch: number, outcome: ExampleRun["outcome"]): void {
    const runs = this.readRuns().map((run) =>
      run.epoch === epoch && run.endedAt === undefined
        ? { ...run, endedAt: Date.now(), outcome }
        : run,
    );
    this.ctx.storage.kv.put(RUNS_KEY, runs);
  }
}
