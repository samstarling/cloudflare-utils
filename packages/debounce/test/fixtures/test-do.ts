import { DebounceAndLease } from "../../src/durable-object";
import type { DebounceAndLeaseConfig } from "../../src/types";

type RunBehavior = "succeed" | "throw" | "hang" | "slow" | "watch-abort";

const RUN_BEHAVIOR_KEY = "test:runBehavior";
const RUN_COUNT_KEY = "test:runCount";
const ERRORS_KEY = "test:errors";
const EXHAUSTED_KEY = "test:exhausted";
const EXHAUSTED_CALL_COUNT_KEY = "test:exhaustedCallCount";
const EPOCH_CHECKS_KEY = "test:epochChecks";
const ABORTED_KEY = "test:aborted";
// "slow" sleeps longer than the fixture's own leaseDurationMs (80), so it's always superseded
// by a reclaim before it wakes up — used to test isCurrentEpoch() against a real supersession.
const SLOW_MS = 150;

export class TestDebounceAndLease extends DebounceAndLease<Env> {
  // In-memory rather than durable storage: it only needs to survive within a single test's
  // sabotage-then-observe window, never across an eviction.
  private setAlarmSabotageCallsToSkip = 0;
  // The same object reference passed to super() below — config's field is `readonly` from the
  // base class's perspective, but this mutates the object it points to, so setMaxReclaims() can
  // change it per-test without a constructor parameter (DO constructors don't take custom args).
  private readonly testConfig: DebounceAndLeaseConfig;
  // Toggled per-test to simulate a consumer's own callback failing — verifies the library
  // swallows that rather than letting it abort finishClaim()/alarm().
  private onRunErrorShouldThrow = false;
  private onExhaustedShouldThrow = false;

  constructor(ctx: DurableObjectState, env: Env) {
    const config: DebounceAndLeaseConfig = {
      quietPeriodMs: 30,
      leaseDurationMs: 80,
      onRunError: (err) => {
        const kv = ctx.storage.kv;
        const errors = kv.get<string[]>(ERRORS_KEY) ?? [];
        errors.push(err instanceof Error ? err.message : String(err));
        kv.put(ERRORS_KEY, errors);
        if (this.onRunErrorShouldThrow) throw new Error("test-induced onRunError failure");
      },
      onExhausted: (key, reclaimCount) => {
        const kv = ctx.storage.kv;
        kv.put(EXHAUSTED_CALL_COUNT_KEY, (kv.get<number>(EXHAUSTED_CALL_COUNT_KEY) ?? 0) + 1);
        const events = kv.get<Array<{ key: string; reclaimCount: number }>>(EXHAUSTED_KEY) ?? [];
        events.push({ key, reclaimCount });
        kv.put(EXHAUSTED_KEY, events);
        if (this.onExhaustedShouldThrow) throw new Error("test-induced onExhausted failure");
      },
    };
    super(ctx, env, config);
    this.testConfig = config;
  }

  async setRunBehavior(mode: RunBehavior): Promise<void> {
    this.ctx.storage.kv.put(RUN_BEHAVIOR_KEY, mode);
  }

  async setMaxReclaims(maxReclaims: number | undefined): Promise<void> {
    this.testConfig.maxReclaims = maxReclaims;
  }

  async setMaxWaitMs(maxWaitMs: number | undefined): Promise<void> {
    this.testConfig.maxWaitMs = maxWaitMs;
  }

  async setRunTimeoutMs(runTimeoutMs: number | undefined): Promise<void> {
    this.testConfig.runTimeoutMs = runTimeoutMs;
  }

  async wasAborted(): Promise<boolean> {
    return this.ctx.storage.kv.get<boolean>(ABORTED_KEY) ?? false;
  }

  async setOnRunErrorThrows(shouldThrow: boolean): Promise<void> {
    this.onRunErrorShouldThrow = shouldThrow;
  }

  async setOnExhaustedThrows(shouldThrow: boolean): Promise<void> {
    this.onExhaustedShouldThrow = shouldThrow;
  }

  async getOnExhaustedCallCount(): Promise<number> {
    return this.ctx.storage.kv.get<number>(EXHAUSTED_CALL_COUNT_KEY) ?? 0;
  }

  async getRunCount(): Promise<number> {
    return this.ctx.storage.kv.get<number>(RUN_COUNT_KEY) ?? 0;
  }

  async getErrors(): Promise<string[]> {
    return this.ctx.storage.kv.get<string[]>(ERRORS_KEY) ?? [];
  }

  async getExhaustedEvents(): Promise<Array<{ key: string; reclaimCount: number }>> {
    return (
      this.ctx.storage.kv.get<Array<{ key: string; reclaimCount: number }>>(EXHAUSTED_KEY) ?? []
    );
  }

  async getEpochChecks(): Promise<boolean[]> {
    return this.ctx.storage.kv.get<boolean[]>(EPOCH_CHECKS_KEY) ?? [];
  }

  /**
   * Writes an unprefixed storage key, standing in for a subclass that persists its own state
   * without knowing the library's key names — the collision the `__debounce:` prefix exists to prevent.
   */
  async writeUnprefixedKey(key: string, value: unknown): Promise<void> {
    this.ctx.storage.kv.put(key, value);
  }

  async readUnprefixedKey(key: string): Promise<unknown> {
    return this.ctx.storage.kv.get(key);
  }

  /**
   * Lets the next `callsToSkip` calls to `storage.setAlarm` through as normal, then fails the
   * one after that — used to simulate a storage failure partway through a re-trigger chain
   * without touching the library's own source.
   */
  async sabotageSetAlarmAfter(callsToSkip: number): Promise<void> {
    this.setAlarmSabotageCallsToSkip = callsToSkip;
    const storage = this.ctx.storage;
    const original = storage.setAlarm.bind(storage);
    storage.setAlarm = (async (...args: Parameters<typeof original>) => {
      if (this.setAlarmSabotageCallsToSkip > 0) {
        this.setAlarmSabotageCallsToSkip--;
        return original(...args);
      }
      storage.setAlarm = original;
      throw new Error("simulated setAlarm failure");
    }) as typeof storage.setAlarm;
  }

  protected async run(_key: string, epoch: number, signal: AbortSignal): Promise<void> {
    const kv = this.ctx.storage.kv;
    kv.put(RUN_COUNT_KEY, (kv.get<number>(RUN_COUNT_KEY) ?? 0) + 1);

    const mode = kv.get<RunBehavior>(RUN_BEHAVIOR_KEY) ?? "succeed";
    if (mode === "throw") throw new Error("test-induced failure");
    if (mode === "hang") return new Promise(() => {});
    if (mode === "watch-abort") {
      // Waits only for the library-supplied abort signal, then records that it fired — proves the
      // signal is wired through run() and aborts on the configured runTimeoutMs schedule.
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      kv.put(ABORTED_KEY, true);
      return;
    }
    if (mode === "slow") {
      await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
      const checks = kv.get<boolean[]>(EPOCH_CHECKS_KEY) ?? [];
      checks.push(this.isCurrentEpoch(epoch));
      kv.put(EPOCH_CHECKS_KEY, checks);
    }
  }
}
