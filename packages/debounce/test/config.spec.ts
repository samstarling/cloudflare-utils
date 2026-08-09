import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DebounceAndLease } from "../src/durable-object";
import type { DebounceAndLeaseConfig } from "../src/types";

/** Minimal concrete subclass: these tests only ever construct it, never run it. */
class ProbeDebounceAndLease extends DebounceAndLease {
  protected async run(): Promise<void> {}
}

/**
 * Runs `fn` with a `build()` that constructs {@link ProbeDebounceAndLease} against a real
 * `DurableObjectState`, so constructor validation can be asserted with a plain
 * `expect(...).toThrow()`.
 *
 * Going through a binding instead doesn't work: a Durable Object constructor takes no custom
 * arguments, so a bad config would have to be baked into the class — and the pool then constructs
 * that instance during RPC property lookup, outside any assertion's reach, surfacing as an
 * unhandled rejection that fails the run even when the assertion itself passes.
 * `runInDurableObject` hands back the real state, and constructing against it inline sidesteps
 * that: nothing is registered as a binding and nothing persists, so each case is free to pass
 * whatever config it likes.
 */
async function withRealState<R>(
  fn: (build: (config: DebounceAndLeaseConfig, ctx?: DurableObjectState) => void) => R,
) {
  const stub = env.TEST_DEBOUNCE.getByName(`config-${Math.random().toString(36).slice(2)}`);
  return runInDurableObject(stub, (_instance, state) =>
    fn((config, ctx) => void new ProbeDebounceAndLease(ctx ?? state, {}, config)),
  );
}

const VALID = { quietPeriodMs: 30, leaseDurationMs: 80 } satisfies DebounceAndLeaseConfig;

describe("config validation", () => {
  it("rejects a non-positive quietPeriodMs", async () => {
    await withRealState((build) => {
      expect(() => build({ ...VALID, quietPeriodMs: 0 })).toThrow(
        /quietPeriodMs and leaseDurationMs must both be positive/,
      );
      expect(() => build({ ...VALID, quietPeriodMs: -1 })).toThrow(
        /quietPeriodMs and leaseDurationMs must both be positive/,
      );
    });
  });

  it("rejects a non-positive leaseDurationMs", async () => {
    await withRealState((build) => {
      expect(() => build({ ...VALID, leaseDurationMs: 0 })).toThrow(
        /quietPeriodMs and leaseDurationMs must both be positive/,
      );
      expect(() => build({ ...VALID, leaseDurationMs: -1 })).toThrow(
        /quietPeriodMs and leaseDurationMs must both be positive/,
      );
    });
  });

  it("rejects a negative maxReclaims but allows 0 and Infinity", async () => {
    await withRealState((build) => {
      expect(() => build({ ...VALID, maxReclaims: -1 })).toThrow(
        /maxReclaims must not be negative/,
      );
      // 0 means "give up on the first lease expiry" and Infinity means "reclaim forever" — both
      // are documented, supported values rather than mistakes.
      expect(() => build({ ...VALID, maxReclaims: 0 })).not.toThrow();
      expect(() => build({ ...VALID, maxReclaims: Number.POSITIVE_INFINITY })).not.toThrow();
    });
  });

  it("rejects a non-positive maxWaitMs, and allows it to be omitted", async () => {
    await withRealState((build) => {
      expect(() => build({ ...VALID, maxWaitMs: 0 })).toThrow(
        /maxWaitMs must be positive when set/,
      );
      expect(() => build({ ...VALID, maxWaitMs: -1 })).toThrow(
        /maxWaitMs must be positive when set/,
      );
      // Unset is the no-ceiling default, and a value below quietPeriodMs is a legitimate throttle.
      expect(() => build({ ...VALID, maxWaitMs: undefined })).not.toThrow();
      expect(() => build({ ...VALID, maxWaitMs: 1 })).not.toThrow();
    });
  });

  // Driven through a real newUniqueId() stub rather than the direct-construction helper above: a
  // hand-made ctx object with id.name masked out is rejected by the native DurableObjectBase
  // constructor ("parameter 1 is not of type 'DurableObjectState'") before this class's own check
  // is ever reached, so the only way to produce a genuinely unnamed id is to ask the platform for
  // one.
  it("rejects an id with no name, since the id name IS the debounce key", async () => {
    const stub = env.TEST_DEBOUNCE.get(env.TEST_DEBOUNCE.newUniqueId());
    await expect(runInDurableObject(stub, () => "unreachable")).rejects.toThrow(
      /must be addressed via getByName\(key\) or idFromName\(key\)/,
    );
  });

  it("accepts a fully valid config", async () => {
    await withRealState((build) => {
      expect(() =>
        build({
          quietPeriodMs: 30,
          leaseDurationMs: 80,
          maxWaitMs: 60,
          maxReclaims: 3,
          onRunError: () => {},
          onExhausted: () => {},
        }),
      ).not.toThrow();
    });
  });
});
