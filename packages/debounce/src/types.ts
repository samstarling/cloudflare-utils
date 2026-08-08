/**
 * Default cap on lease-expiry reclaims of a single unconfirmed execution. Finite by design: an
 * uncapped default turns one permanently hanging `run()` into an alarm firing every
 * `leaseDurationMs` forever, which bills a request and a row write per cycle indefinitely.
 */
export const DEFAULT_MAX_RECLAIMS = 10;

export interface DebounceAndLeaseConfig {
  /** How long a key must go without a new signal before its action runs. */
  quietPeriodMs: number;
  /** How long a claimed execution may run before it's presumed dead and the key becomes eligible again. */
  leaseDurationMs: number;
  /**
   * Ceiling on how long a key may sit `"pending"` before it runs regardless of continued signals,
   * measured from the signal that first made it pending. Unset means no ceiling — a key signalled
   * more often than once per `quietPeriodMs` then never runs at all, since every `signal()` pushes
   * the deadline out again. Set this whenever a steady stream of signals is possible and the action
   * still needs to happen eventually.
   *
   * The effective deadline is `min(now + quietPeriodMs, pendingSince + maxWaitMs)`, so it only ever
   * moves the run earlier, never later. A value below `quietPeriodMs` makes every cycle fire at
   * `maxWaitMs` — a throttle rather than a debounce, which is a legitimate thing to configure. The
   * window restarts from scratch on the next cycle, including one started by a coalesced `signal()`.
   */
  maxWaitMs?: number;
  /**
   * How many times a lease may expire on the same unconfirmed execution before giving up on it
   * automatically. Defaults to {@link DEFAULT_MAX_RECLAIMS}; pass `Infinity` to retry forever.
   * Once exceeded, the key moves to the terminal `"exhausted"` state (no further reclaim is
   * scheduled) and `onExhausted` is called, so treat that callback as the signal to alert or
   * call `cancel()`.
   */
  maxReclaims?: number;
  /** Called when `run()` throws. The error is otherwise swallowed — see the README's correctness guarantee. */
  onRunError?: (error: unknown, key: string) => void;
  /**
   * Called once `maxReclaims` is exceeded by a `run()` that keeps failing to settle before its
   * lease expires. The key moves to `"exhausted"` at that point: no alarm remains armed, so it
   * stays there until `cancel()` resets it, or until the abandoned `run()` finally settles for
   * real. Treat this callback as an alert.
   */
  onExhausted?: (key: string, reclaimCount: number) => void;
}

export type DebounceAndLeaseState = "idle" | "pending" | "claimed" | "exhausted";

interface DebounceAndLeaseStatusBase {
  key: string;
  /** True if a signal()/flush() arrived mid-flight and is queued for after this run. */
  coalescedPending?: boolean;
}

export type DebounceAndLeaseStatus =
  | (DebounceAndLeaseStatusBase & {
      state: "idle";
      /** Epoch ms since the key went idle. Undefined for a key that has never completed a claim. */
      since?: number;
    })
  | (DebounceAndLeaseStatusBase & {
      state: "pending";
      /** Epoch ms since the current state was entered. */
      since: number;
      /** When the action will run: the quiet period elapsing, or `maxWaitMs` capping it short. */
      debounceDeadline?: number;
    })
  | (DebounceAndLeaseStatusBase & {
      state: "claimed";
      /** Epoch ms since the current state was entered. */
      since: number;
      /** When this claim's lease expires. */
      leaseDeadline?: number;
      /** How many times this execution has already been reclaimed. Absent means none. */
      reclaimCount?: number;
    })
  /**
   * Terminal: `maxReclaims` was exceeded by a `run()` that never settled, so no alarm is armed
   * and nothing will move this key on its own. Call `cancel()` to reset it. Distinct from
   * `"claimed"` precisely because there is no live lease here, only an abandoned execution.
   */
  | (DebounceAndLeaseStatusBase & {
      state: "exhausted";
      /** Epoch ms the abandoned claim began. */
      since: number;
      /** How many times the abandoned execution was reclaimed before giving up. */
      reclaimCount: number;
    });
