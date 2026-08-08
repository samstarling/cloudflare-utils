import { DebounceAndLease } from "../../src/durable-object";
import { mulberry32Step } from "./prng";

export const CHAOS_QUIET_PERIOD_MS = 15;
export const CHAOS_LEASE_DURATION_MS = 40;

const LOCAL_EPOCH_KEY = "chaos:localEpoch";
const RECORD_PREFIX = "chaos:record:";
const RNG_STATE_KEY = "chaos:rngState";

export interface ChaosRecord {
  epoch: number;
  startedAt: number;
  endedAt?: number;
  outcome?: "succeeded" | "threw";
}

// run() randomly succeeds, throws, or "crashes" (never resolves), recording a durable history of
// each invocation's start/end for test/chaos.spec.ts to check.
export class ChaosDebounceAndLease extends DebounceAndLease<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, {
      quietPeriodMs: CHAOS_QUIET_PERIOD_MS,
      leaseDurationMs: CHAOS_LEASE_DURATION_MS,
      // Uncapped on purpose: the run() below crashes ~15% of the time, and this test needs every
      // one of those to be reclaimed so the exclusivity checker sees the full overlap history.
      // Under the finite default a key could exhaust mid-test and stop producing executions.
      maxReclaims: Number.POSITIVE_INFINITY,
    });
  }

  async getHistory(): Promise<ChaosRecord[]> {
    const records: ChaosRecord[] = [];
    for (const [, value] of this.ctx.storage.kv.list<ChaosRecord>({ prefix: RECORD_PREFIX })) {
      records.push(value);
    }
    return records.sort((a, b) => a.epoch - b.epoch);
  }

  async seed(value: number): Promise<void> {
    this.ctx.storage.kv.put(RNG_STATE_KEY, value >>> 0);
  }

  private nextRandom(): number {
    const kv = this.ctx.storage.kv;
    const { value, nextState } = mulberry32Step(kv.get<number>(RNG_STATE_KEY) ?? 0);
    kv.put(RNG_STATE_KEY, nextState);
    return value;
  }

  protected async run(_key: string, _libraryEpoch: number): Promise<void> {
    const kv = this.ctx.storage.kv;
    const epoch = (kv.get<number>(LOCAL_EPOCH_KEY) ?? 0) + 1;
    kv.put(LOCAL_EPOCH_KEY, epoch);
    const recordKey = `${RECORD_PREFIX}${epoch}`;
    const startedAt = Date.now();
    kv.put<ChaosRecord>(recordKey, { epoch, startedAt });

    const roll = this.nextRandom();
    if (roll < 0.15) {
      // Crash: never resolves, so the record is left with no end.
      return new Promise(() => {});
    }
    if (roll < 0.3) {
      kv.put<ChaosRecord>(recordKey, { epoch, startedAt, endedAt: Date.now(), outcome: "threw" });
      throw new Error("chaos: simulated failure");
    }
    if (roll < 0.45) {
      // Slow-succeed: outlives the lease, so a reclaim supersedes it before it resolves —
      // exercises the fencing-token guard against a belated finishClaim().
      const slowDelay = Math.floor(CHAOS_LEASE_DURATION_MS * (1.2 + this.nextRandom() * 1.5));
      await new Promise((resolve) => setTimeout(resolve, slowDelay));
      kv.put<ChaosRecord>(recordKey, {
        epoch,
        startedAt,
        endedAt: Date.now(),
        outcome: "succeeded",
      });
      return;
    }
    const delay = Math.floor(this.nextRandom() * (CHAOS_QUIET_PERIOD_MS / 2));
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    kv.put<ChaosRecord>(recordKey, {
      epoch,
      startedAt,
      endedAt: Date.now(),
      outcome: "succeeded",
    });
  }
}
