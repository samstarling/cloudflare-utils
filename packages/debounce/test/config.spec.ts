import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DebounceAndLease } from "../src/durable-object";
import type { DebounceAndLeaseConfig } from "../src/types";

/**
 * Constructor validation can't be driven through a stub: a Durable Object constructor takes no
 * custom arguments, so a bad config has to be baked into the class — and the pool then constructs
 * that instance during RPC property lookup, outside any assertion's reach, surfacing as an
 * unhandled rejection that fails the run even when the assertion passes.
 *
 * `runInDurableObject` hands back the real `DurableObjectState`, so instead these tests construct
 * a throwaway subclass directly against it. The constructor runs inline, inside the callback,
 * where a plain `expect(...).toThrow()` can see it. Nothing is registered as a binding and nothing
 * persists, so each case is free to pass whatever config it likes.
 */
class ProbeDebounceAndLease extends DebounceAndLease {
  protected async run(): Promise<void> {}
}

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
      expect(() => build({ ...VALID, maxReclaims: -1 })).toThrow(/maxReclaims must not be negative/);
      // 0 means "give up on the first lease expiry" and Infinity means "reclaim forever" — both
      // are documented, supported values rather than mistakes.
      expect(() => build({ ...VALID, maxReclaims: 0 })).not.toThrow();
      expect(() => build({ ...VALID, maxReclaims: Number.POSITIVE_INFINITY })).not.toThrow();
    });
  });

  it("rejects a non-positive maxWaitMs, and allows it to be omitted", async () => {
    await withRealState((build) => {
      expect(() => build({ ...VALID, maxWaitMs: 0 })).toThrow(/maxWaitMs must be positive when set/);
      expect(() => build({ ...VALID, maxWaitMs: -1 })).toThrow(
        /maxWaitMs must be positive when set/,
      );
      // Unset is the no-ceiling default, and a value below quietPeriodMs is a legitimate throttle.
      expect(() => build({ ...VALID, maxWaitMs: undefined })).not.toThrow();
      expect(() => build({ ...VALID, maxWaitMs: 1 })).not.toThrow();
    });
  });

  it("rejects an id with no name, since the id name IS the debounce key", async () => {
    await withRealState((build) => {
      // A real state object with its id.name masked out, standing in for the newUniqueId() case:
      // the whole class keys off ctx.id.name, so an unnamed id has no key to debounce on.
      const unnamed = (state: DurableObjectState) =>
        ({
          ...state,
          id: { ...state.id, name: undefined },
        }) as unknown as DurableObjectState;

      expect(() =>
        build(VALID, unnamed({ id: { name: "x" } } as unknown as DurableObjectState)),
      ).toThrow(/must be addressed via getByName\(key\) or idFromName\(key\)/);
    });
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
