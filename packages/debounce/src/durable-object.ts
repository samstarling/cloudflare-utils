import { DurableObject } from "cloudflare:workers";
import {
  DEFAULT_MAX_RECLAIMS,
  type DebounceAndLeaseConfig,
  type DebounceAndLeaseStatus,
} from "./types";

type Coalesced = "signal" | "flush";

function required<T>(value: T | undefined, field: string): T {
  if (value === undefined) {
    throw new Error(
      `cloudflare-utils-debounce: invariant violated — "${field}" missing from storage`,
    );
  }
  return value;
}

/**
 * Prefix reserving this library's storage keys. Subclasses share the same `storage.kv` namespace,
 * and a subclass persisting its own state under a bare name like `"state"` would silently corrupt
 * the state machine rather than fail loudly. Everything the library owns lives under here, so
 * subclasses only need to avoid this one prefix.
 */
const PREFIX = "__dbl:";

const KEYS = {
  state: `${PREFIX}state`,
  idleSince: `${PREFIX}idleSince`,
  pendingSince: `${PREFIX}pendingSince`,
  debounceDeadline: `${PREFIX}debounceDeadline`,
  claimedSince: `${PREFIX}claimedSince`,
  leaseDeadline: `${PREFIX}leaseDeadline`,
  claimEpoch: `${PREFIX}claimEpoch`,
  coalesced: `${PREFIX}coalesced`,
  reclaimCount: `${PREFIX}reclaimCount`,
} as const;

/**
 * Base class for a debounce scope. Subclass this, implement `run()`, and forward
 * your configuration to `super()`. See the README for the full integration shape and the
 * correctness guarantee this class provides.
 *
 * Must be addressed via `namespace.getByName(key)` (or `idFromName(key)` + `.get()`) — the
 * Durable Object's own id name IS the debounce key. Must be bound as a
 * `new_sqlite_classes` migration (not `new_classes`) — this class relies on the
 * SQLite-backed synchronous `storage.kv` API for its concurrency guarantees.
 */
export abstract class DebounceAndLease<Env = unknown> extends DurableObject<Env> {
  protected readonly key: string;

  constructor(
    ctx: DurableObjectState,
    env: Env,
    private readonly config: DebounceAndLeaseConfig,
  ) {
    super(ctx, env);
    if (!ctx.id.name) {
      throw new Error(
        "DebounceAndLease must be addressed via getByName(key) or idFromName(key) — got a " +
          "DurableObjectId with no name (created via newUniqueId()?).",
      );
    }
    this.key = ctx.id.name;
    if (config.quietPeriodMs <= 0 || config.leaseDurationMs <= 0) {
      throw new Error("quietPeriodMs and leaseDurationMs must both be positive.");
    }
    if (config.maxReclaims !== undefined && config.maxReclaims < 0) {
      throw new Error("maxReclaims must not be negative.");
    }
    if (config.maxWaitMs !== undefined && config.maxWaitMs <= 0) {
      throw new Error("maxWaitMs must be positive when set.");
    }
  }

  /** The reclaim cap in force, falling back to the library default when unconfigured. */
  private get maxReclaims(): number {
    return this.config.maxReclaims ?? DEFAULT_MAX_RECLAIMS;
  }

  /**
   * The action to run once a burst of signals goes quiet. The library guarantees at most one
   * execution in flight per key — see the README for the exact correctness guarantee and its
   * one documented exception. This action is not given an internal timeout: give it one of
   * your own, well under `leaseDurationMs`, so it always eventually settles.
   *
   * `epoch` identifies this specific claim — it increases every time the key is claimed,
   * including a lease-expiry reclaim. It fences the library's *own* bookkeeping against a
   * stale, abandoned invocation finishing late and clobbering newer state, but it does nothing
   * to protect your side effect from running twice during that same overlap. If `run()` does
   * something that isn't safe to run twice, check `this.isCurrentEpoch(epoch)` right before
   * doing it — false means a reclaim has already superseded this invocation and it should stop
   * rather than act. This is a mitigation, not a substitute for idempotency: it only helps if
   * `run()` checks it before the side effect, not after.
   */
  protected abstract run(key: string, epoch: number): Promise<void>;

  /** True if `epoch` (as passed to `run()`) is still the key's current claim. */
  protected isCurrentEpoch(epoch: number): boolean {
    return this.ctx.storage.kv.get<number>(KEYS.claimEpoch) === epoch;
  }

  /**
   * Forces the key back to idle, discarding whatever state it was in — including a queued
   * coalesced signal()/flush() and, most usefully, a key left in "exhausted" (an abandoned
   * `run()` that will never confirm completion). Bumps the claim
   * epoch, so if that abandoned `run()` ever does finish for real afterward, its `finishClaim()`
   * still safely no-ops against the now-superseded epoch instead of clobbering whatever this
   * key has moved on to since.
   */
  async cancel(): Promise<DebounceAndLeaseStatus> {
    const kv = this.ctx.storage.kv;
    const nextEpoch = (kv.get<number>(KEYS.claimEpoch) ?? 0) + 1;
    kv.put(KEYS.claimEpoch, nextEpoch);
    kv.delete(KEYS.coalesced);
    kv.delete(KEYS.state);
    kv.delete(KEYS.pendingSince);
    kv.delete(KEYS.debounceDeadline);
    kv.delete(KEYS.claimedSince);
    kv.delete(KEYS.leaseDeadline);
    kv.delete(KEYS.reclaimCount);
    kv.put(KEYS.idleSince, Date.now());
    await this.ctx.storage.deleteAlarm();
    return this.status();
  }

  async signal(): Promise<DebounceAndLeaseStatus> {
    const kv = this.ctx.storage.kv;
    const now = Date.now();
    const state = kv.get<string>(KEYS.state);

    // "exhausted" is grouped with "claimed" here on purpose: an abandoned run() may still be
    // alive, so the signal is queued for its finishClaim() rather than starting a competing
    // execution. It only ever fires if that run settles for real; otherwise cancel() clears it.
    // Falling through instead would arm an alarm that matches no branch in alarm().
    if (state === "claimed" || state === "exhausted") {
      const coalesced = kv.get<Coalesced>(KEYS.coalesced);
      if (coalesced !== "flush" && coalesced !== "signal") {
        kv.put(KEYS.coalesced, "signal" satisfies Coalesced);
      }
      return this.status();
    }

    if (state === undefined) {
      kv.put(KEYS.state, "pending");
      kv.put(KEYS.pendingSince, now);
      kv.delete(KEYS.idleSince);
    }
    // Read back rather than reusing `now`: on a signal that extends an existing pending window this
    // is the *original* pendingSince, which is what maxWaitMs is measured from.
    const pendingSince = required(kv.get<number>(KEYS.pendingSince), KEYS.pendingSince);
    const deadline = this.debounceDeadlineFrom(now, pendingSince);
    kv.put(KEYS.debounceDeadline, deadline);
    await this.ctx.storage.setAlarm(deadline);
    return this.status();
  }

  /**
   * The quiet period from `now`, pulled earlier by the `maxWaitMs` ceiling if one is set. Only ever
   * earlier than the plain quiet period, so a key can't be starved indefinitely by signals arriving
   * faster than `quietPeriodMs`.
   */
  private debounceDeadlineFrom(now: number, pendingSince: number): number {
    const quietDeadline = now + this.config.quietPeriodMs;
    if (this.config.maxWaitMs === undefined) return quietDeadline;
    return Math.min(quietDeadline, pendingSince + this.config.maxWaitMs);
  }

  async flush(): Promise<DebounceAndLeaseStatus> {
    const kv = this.ctx.storage.kv;
    const state = kv.get<string>(KEYS.state);
    // As in signal(): queued rather than run, since the abandoned execution may still be alive.
    if (state === "claimed" || state === "exhausted") {
      kv.put(KEYS.coalesced, "flush" satisfies Coalesced);
      return this.status();
    }
    if (state === "pending") {
      await this.claimAndRun();
    }
    // Idle: nothing signaled, nothing running — flush() has nothing to do.
    return this.status();
  }

  async status(): Promise<DebounceAndLeaseStatus> {
    const kv = this.ctx.storage.kv;
    const state = kv.get<string>(KEYS.state);
    const coalescedPending = kv.get<Coalesced>(KEYS.coalesced) !== undefined;

    if (state === "pending") {
      return {
        key: this.key,
        state: "pending",
        since: required(kv.get<number>(KEYS.pendingSince), KEYS.pendingSince),
        debounceDeadline: kv.get<number>(KEYS.debounceDeadline),
        coalescedPending,
      };
    }
    if (state === "claimed") {
      return {
        key: this.key,
        state: "claimed",
        since: required(kv.get<number>(KEYS.claimedSince), KEYS.claimedSince),
        leaseDeadline: kv.get<number>(KEYS.leaseDeadline),
        reclaimCount: kv.get<number>(KEYS.reclaimCount),
        coalescedPending,
      };
    }
    if (state === "exhausted") {
      return {
        key: this.key,
        state: "exhausted",
        since: required(kv.get<number>(KEYS.claimedSince), KEYS.claimedSince),
        reclaimCount: required(kv.get<number>(KEYS.reclaimCount), KEYS.reclaimCount) - 1,
        coalescedPending,
      };
    }
    return {
      key: this.key,
      state: "idle",
      since: kv.get<number>(KEYS.idleSince),
    };
  }

  override async alarm(_alarmInfo?: AlarmInvocationInfo): Promise<void> {
    const kv = this.ctx.storage.kv;
    const now = Date.now();
    const state = kv.get<string>(KEYS.state);

    if (state === "pending") {
      const deadline = required(kv.get<number>(KEYS.debounceDeadline), KEYS.debounceDeadline);
      if (now < deadline) {
        await this.ctx.storage.setAlarm(deadline);
        return;
      }
      await this.claimAndRun();
      return;
    }

    if (state === "claimed") {
      const leaseDeadline = required(kv.get<number>(KEYS.leaseDeadline), KEYS.leaseDeadline);
      if (now < leaseDeadline) {
        await this.ctx.storage.setAlarm(leaseDeadline);
        return;
      }
      // Lease expired while still claimed: the prior execution is presumed dead. Reclaim and
      // re-run. This is the documented exception window in the correctness guarantee — the
      // prior run may still legitimately be executing when this happens.
      const reclaimCount = (kv.get<number>(KEYS.reclaimCount) ?? 0) + 1;
      // Persisted before onExhausted runs below: if that callback throws, the retried alarm()
      // invocation must see this same reclaimCount already recorded, not recompute it and refire
      // the callback again.
      kv.put(KEYS.reclaimCount, reclaimCount);
      if (reclaimCount > this.maxReclaims) {
        // Give up: move to the terminal "exhausted" state rather than scheduling another reclaim.
        // Deliberately leaves claimEpoch and claimedSince untouched, so if the abandoned run()
        // ever does finish for real, its own finishClaim() still fires normally against this same
        // epoch and cleans the key back to idle.
        kv.put(KEYS.state, "exhausted");
        kv.delete(KEYS.leaseDeadline); // no lease is live here; nothing is armed to reclaim it
        this.invokeOnExhausted(reclaimCount - 1);
        return;
      }
      await this.claimAndRun();
      return;
    }

    // Idle, or exhausted and waiting on cancel(): a stray alarm left over from a prior cycle.
    // Nothing here should re-arm it — an exhausted key is terminal by design.
    await this.ctx.storage.deleteAlarm();
  }

  private async claimAndRun(): Promise<void> {
    const kv = this.ctx.storage.kv;
    const now = Date.now();
    const leaseDeadline = now + this.config.leaseDurationMs;
    const myEpoch = (kv.get<number>(KEYS.claimEpoch) ?? 0) + 1;

    kv.delete(KEYS.pendingSince);
    kv.delete(KEYS.debounceDeadline);
    kv.put(KEYS.state, "claimed");
    kv.put(KEYS.claimedSince, now);
    kv.put(KEYS.leaseDeadline, leaseDeadline);
    kv.put(KEYS.claimEpoch, myEpoch);
    await this.ctx.storage.setAlarm(leaseDeadline);

    this.ctx.waitUntil(this.runAndFinish(myEpoch));
  }

  private async runAndFinish(myEpoch: number): Promise<void> {
    try {
      await this.run(this.key, myEpoch);
    } catch (err) {
      this.invokeOnRunError(err);
    }
    try {
      await this.finishClaim(myEpoch);
    } catch (err) {
      this.invokeOnRunError(err);
    }
  }

  // Both helpers below swallow anything a consumer's own callback throws. Without this, a
  // throwing onRunError would abort runAndFinish() before its second try block ever calls
  // finishClaim(), stranding the key in "claimed" until the lease alarm eventually reclaims it;
  // a throwing onExhausted would escape alarm() itself, which the platform treats as a failed
  // invocation and retries with its own backoff — independent of, and racing, our lease timing.

  private invokeOnRunError(err: unknown): void {
    try {
      this.config.onRunError?.(err, this.key);
    } catch {
      // See comment above: never let this escape.
    }
  }

  private invokeOnExhausted(reclaimCount: number): void {
    try {
      this.config.onExhausted?.(this.key, reclaimCount);
    } catch {
      // See comment above: never let this escape.
    }
  }

  private async finishClaim(myEpoch: number): Promise<void> {
    const kv = this.ctx.storage.kv;
    if (kv.get<number>(KEYS.claimEpoch) !== myEpoch) {
      // A later reclaim (this key's lease expired mid-run) now owns state. Do nothing —
      // that claim's own finishClaim will run the cleanup and honor any coalesced signal.
      return;
    }

    const coalesced = kv.get<Coalesced>(KEYS.coalesced);
    kv.delete(KEYS.coalesced);
    kv.delete(KEYS.state);
    kv.delete(KEYS.claimedSince);
    kv.delete(KEYS.leaseDeadline);
    kv.delete(KEYS.reclaimCount);
    kv.put(KEYS.idleSince, Date.now());

    // A coalesced re-trigger is about to set its own alarm, so skip the round trip of deleting
    // this one first — and skip it entirely when this fails, rather than let it block the
    // re-trigger below.
    if (coalesced === "flush") {
      await this.claimAndRun();
      return;
    }
    if (coalesced === "signal") {
      await this.signal();
      return;
    }
    await this.ctx.storage.deleteAlarm();
  }
}
