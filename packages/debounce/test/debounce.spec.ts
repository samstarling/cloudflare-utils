import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_RECLAIMS } from "../src/types";
import { wait } from "./fixtures/wait";

const QUIET_PERIOD_MS = 30;
const LEASE_DURATION_MS = 80;
const MARGIN_MS = 40;

let keyCounter = 0;
function freshStub() {
  const key = `key-${++keyCounter}-${Math.random().toString(36).slice(2)}`;
  return { key, stub: env.TEST_DEBOUNCE.getByName(key) };
}

describe("debounce", () => {
  it("collapses N signals within the quiet period into exactly 1 execution", async () => {
    const { stub } = freshStub();
    await stub.setRunBehavior("succeed");

    await stub.signal();
    await stub.signal();
    await stub.signal();
    await stub.signal();
    await stub.signal();

    await wait(QUIET_PERIOD_MS + MARGIN_MS);
    await runDurableObjectAlarm(stub);

    expect(await stub.getRunCount()).toBe(1);
    expect((await stub.status()).state).toBe("idle");
  });
});

describe("max wait", () => {
  it("still runs a key signalled faster than the quiet period, instead of starving it forever", async () => {
    const { stub } = freshStub();
    await stub.setRunBehavior("succeed");
    await stub.setMaxWaitMs(QUIET_PERIOD_MS * 2);

    // Signals every QUIET_PERIOD_MS/2 for 8 quiet periods' worth of wall clock, so the quiet
    // period alone never elapses during the burst. Asserted mid-burst, with no forced alarm and no
    // trailing wait: both would let an uncapped key fire once the signals stopped, which is exactly
    // the starvation this is meant to catch. It has to fire while signals are still arriving.
    await stub.signal();
    for (let i = 0; i < 16; i++) {
      await wait(QUIET_PERIOD_MS / 2);
      await stub.signal();
    }

    expect(await stub.getRunCount()).toBeGreaterThanOrEqual(1);
  });

  it("caps the reported deadline at pendingSince + maxWaitMs rather than pushing it out", async () => {
    const { stub } = freshStub();
    await stub.setRunBehavior("succeed");
    // Two constraints pin this value. Each signal must land while the cap is already binding
    // (elapsed > maxWaitMs - quietPeriodMs) but before the currently armed deadline fires and ends
    // the window (elapsed < quietPeriodMs) — so maxWaitMs has to sit strictly between one and two
    // quiet periods, and every wait below inside (10ms, 30ms).
    const MAX_WAIT_MS = QUIET_PERIOD_MS + 10;
    await stub.setMaxWaitMs(MAX_WAIT_MS);

    const first = await stub.signal();
    if (first.state !== "pending") throw new Error("expected pending status");
    const ceiling = first.since + MAX_WAIT_MS;
    expect(first.debounceDeadline).toBe(first.since + QUIET_PERIOD_MS); // quiet period, still inside

    // This signal wants now + quietPeriodMs, which is past the ceiling — so the ceiling wins and
    // the deadline stops moving instead of being pushed out again.
    await wait(15);
    const second = await stub.signal();
    if (second.state !== "pending") throw new Error("expected pending status");
    expect(second.since).toBe(first.since); // same pending window, not restarted
    expect(second.debounceDeadline).toBe(ceiling);

    await wait(10);
    const third = await stub.signal();
    if (third.state !== "pending") throw new Error("expected pending status");
    expect(third.debounceDeadline).toBe(ceiling); // pinned, however many more signals arrive
  });

  it("leaves the quiet period alone when the ceiling is never reached", async () => {
    const { stub } = freshStub();
    await stub.setRunBehavior("succeed");
    await stub.setMaxWaitMs(QUIET_PERIOD_MS * 20); // far beyond anything this test reaches

    await stub.signal();
    await stub.signal();
    const pending = await stub.signal();
    if (pending.state !== "pending") throw new Error("expected pending status");
    expect(pending.debounceDeadline).toBeLessThanOrEqual(Date.now() + QUIET_PERIOD_MS);

    await wait(QUIET_PERIOD_MS + MARGIN_MS);
    await runDurableObjectAlarm(stub);

    expect(await stub.getRunCount()).toBe(1); // ordinary debounce, collapsed as usual
    expect((await stub.status()).state).toBe("idle");
  });

  it("restarts the max-wait window on the cycle after a run, including via a coalesced signal", async () => {
    const { stub } = freshStub();
    await stub.setRunBehavior("succeed");
    await stub.setMaxWaitMs(QUIET_PERIOD_MS * 2);

    await stub.signal();
    await stub.flush();
    expect(await stub.getRunCount()).toBe(1);

    // A brand new cycle measures maxWaitMs from its own first signal, not from the old window.
    const next = await stub.signal();
    if (next.state !== "pending") throw new Error("expected pending status");
    expect(next.debounceDeadline).toBe(next.since + QUIET_PERIOD_MS);
  });

  it("behaves as a throttle when maxWaitMs is below the quiet period", async () => {
    const { stub } = freshStub();
    await stub.setRunBehavior("succeed");
    await stub.setMaxWaitMs(QUIET_PERIOD_MS / 3); // deliberately shorter: fires on a fixed interval

    const pending = await stub.signal();
    if (pending.state !== "pending") throw new Error("expected pending status");
    expect(pending.debounceDeadline).toBe(pending.since + QUIET_PERIOD_MS / 3);

    await wait(QUIET_PERIOD_MS + MARGIN_MS);
    await runDurableObjectAlarm(stub).catch(() => {});

    expect(await stub.getRunCount()).toBe(1);
  });

  // A non-positive maxWaitMs is rejected in the constructor — see config.spec.ts, which covers
  // that alongside the quietPeriodMs/leaseDurationMs/maxReclaims/id-name checks.
});

describe("reserved storage keys", () => {
  it("does not collide with a subclass writing unprefixed keys of the same name", async () => {
    const { stub } = freshStub();
    await stub.setRunBehavior("succeed");

    // Exactly the names the library used before they were prefixed. A subclass writing these must
    // be inert as far as the state machine is concerned.
    await stub.writeUnprefixedKey("state", "subclass-owned");
    await stub.writeUnprefixedKey("claimEpoch", 9999);
    await stub.writeUnprefixedKey("pendingSince", 1);
    await stub.writeUnprefixedKey("leaseDeadline", 1);
    await stub.writeUnprefixedKey("coalesced", "flush");

    // The library still sees a pristine idle key, not "subclass-owned".
    expect((await stub.status()).state).toBe("idle");

    await stub.signal();
    expect((await stub.status()).state).toBe("pending");
    await wait(QUIET_PERIOD_MS + MARGIN_MS);
    await runDurableObjectAlarm(stub);

    expect(await stub.getRunCount()).toBe(1);
    expect((await stub.status()).state).toBe("idle");

    // ...and a full cycle left the subclass's own values untouched.
    expect(await stub.readUnprefixedKey("state")).toBe("subclass-owned");
    expect(await stub.readUnprefixedKey("claimEpoch")).toBe(9999);
  });

  it("cancel() leaves a subclass's unprefixed keys alone", async () => {
    const { stub } = freshStub();
    await stub.setRunBehavior("hang");
    await stub.writeUnprefixedKey("state", "subclass-owned");

    await stub.signal();
    await stub.flush();
    expect((await stub.status()).state).toBe("claimed");

    expect((await stub.cancel()).state).toBe("idle");
    expect(await stub.readUnprefixedKey("state")).toBe("subclass-owned");
  });
});

describe("key isolation", () => {
  it("never lets two keys affect each other's timing or exclusivity", async () => {
    const a = freshStub();
    const b = freshStub();

    await a.stub.setRunBehavior("succeed");
    await b.stub.setRunBehavior("succeed");

    await a.stub.signal();
    await a.stub.signal();
    await a.stub.signal();

    expect((await b.stub.status()).state).toBe("idle");
    expect(await b.stub.getRunCount()).toBe(0);

    await wait(QUIET_PERIOD_MS + MARGIN_MS);
    await runDurableObjectAlarm(a.stub);

    expect(await a.stub.getRunCount()).toBe(1);
    expect(await b.stub.getRunCount()).toBe(0);
    expect((await b.stub.status()).state).toBe("idle");
  });
});

describe("concurrent signals", () => {
  it("still results in exactly 1 execution claiming the key", async () => {
    const { stub } = freshStub();
    await stub.setRunBehavior("succeed");

    await Promise.all([stub.signal(), stub.signal()]);

    await wait(QUIET_PERIOD_MS + MARGIN_MS);
    await runDurableObjectAlarm(stub);

    expect(await stub.getRunCount()).toBe(1);
  });
});

describe("crash self-healing", () => {
  it("is not eligible again before the lease elapses", async () => {
    const { stub } = freshStub();
    await stub.setRunBehavior("hang");

    await stub.signal();
    await stub.flush();
    expect(await stub.getRunCount()).toBe(1);

    // Force-fire the alarm well before the lease is due — should just re-arm, not reclaim.
    await runDurableObjectAlarm(stub);
    expect(await stub.getRunCount()).toBe(1);
    expect((await stub.status()).state).toBe("claimed");
  });

  it("becomes eligible again once the lease duration has elapsed", async () => {
    const { stub } = freshStub();
    await stub.setRunBehavior("hang");

    await stub.signal();
    await stub.flush();
    const firstStatus = await stub.status();
    if (firstStatus.state !== "claimed") throw new Error("expected claimed status");
    const firstClaimedSince = firstStatus.since;

    await wait(LEASE_DURATION_MS + MARGIN_MS);
    await runDurableObjectAlarm(stub);

    expect(await stub.getRunCount()).toBe(2);
    const status = await stub.status();
    if (status.state !== "claimed") throw new Error("expected claimed status");
    expect(status.since).toBeGreaterThan(firstClaimedSince);
  });
});

describe("giving up", () => {
  it("stops reclaiming and calls onExhausted once maxReclaims is exceeded, leaving the key stuck", async () => {
    const { key, stub } = freshStub();
    await stub.setRunBehavior("hang");
    await stub.setMaxReclaims(1);

    await stub.signal();
    await stub.flush();
    expect(await stub.getRunCount()).toBe(1);

    // 1st lease expiry is within budget (maxReclaims=1): reclaims and runs again.
    await wait(LEASE_DURATION_MS + MARGIN_MS);
    await runDurableObjectAlarm(stub); // harmless: lands in the "re-arm, not reclaim" branch
    expect(await stub.getRunCount()).toBe(2);
    expect((await stub.status()).state).toBe("claimed");
    expect(await stub.getExhaustedEvents()).toEqual([]);

    // 2nd lease expiry exceeds the budget: gives up instead of reclaiming again. Relying on the
    // platform's own alarm firing here rather than also forcing a check afterward, like the
    // sabotage test above: once exhausted, nothing reschedules the alarm, so an extra forced
    // check would just recompute the same already-exhausted condition and report onExhausted a
    // second time.
    await wait(LEASE_DURATION_MS + MARGIN_MS);

    expect(await stub.getRunCount()).toBe(2); // no third run
    const exhausted = await stub.status();
    expect(exhausted.state).toBe("exhausted"); // terminal, not idle and not still "claimed"
    if (exhausted.state !== "exhausted") throw new Error("expected exhausted status");
    expect(exhausted.reclaimCount).toBe(1);
    expect(await stub.getExhaustedEvents()).toEqual([{ key, reclaimCount: 1 }]);
  });

  it("applies a finite reclaim cap by default, rather than reclaiming forever", async () => {
    const { stub } = freshStub();
    await stub.setRunBehavior("hang");
    // No setMaxReclaims() call: exercises the library's own DEFAULT_MAX_RECLAIMS.
    expect(DEFAULT_MAX_RECLAIMS).toBeLessThan(Number.POSITIVE_INFINITY);

    await stub.signal();
    await stub.flush();
    expect(await stub.getRunCount()).toBe(1);

    // Drive well past the cap: every lease expiry up to it reclaims, then it gives up for good.
    for (let i = 0; i < DEFAULT_MAX_RECLAIMS + 3; i++) {
      await wait(LEASE_DURATION_MS + MARGIN_MS);
      await runDurableObjectAlarm(stub).catch(() => {}); // no-op once nothing is scheduled
    }

    // 1 initial run + DEFAULT_MAX_RECLAIMS reclaims, and no more however long we wait.
    expect(await stub.getRunCount()).toBe(DEFAULT_MAX_RECLAIMS + 1);
    expect(await stub.getExhaustedEvents()).toEqual([
      { key: expect.any(String), reclaimCount: DEFAULT_MAX_RECLAIMS },
    ]);
    const status = await stub.status();
    expect(status.state).toBe("exhausted"); // terminal, awaiting cancel()
    if (status.state !== "exhausted") throw new Error("expected exhausted status");
    expect(status.reclaimCount).toBe(DEFAULT_MAX_RECLAIMS);
  });

  it("retries forever when maxReclaims is explicitly Infinity", async () => {
    const { stub } = freshStub();
    await stub.setRunBehavior("hang");
    await stub.setMaxReclaims(Number.POSITIVE_INFINITY);

    await stub.signal();
    await stub.flush();

    for (let i = 0; i < 3; i++) {
      await wait(LEASE_DURATION_MS + MARGIN_MS);
      await runDurableObjectAlarm(stub).catch(() => {});
    }

    // Still reclaiming, never exhausted.
    expect(await stub.getRunCount()).toBeGreaterThan(2);
    expect(await stub.getExhaustedEvents()).toEqual([]);
  });

  it("queues rather than runs a signal()/flush() arriving at an exhausted key, and arms no alarm", async () => {
    const { stub } = freshStub();
    await stub.setRunBehavior("hang");
    await stub.setMaxReclaims(0);

    await stub.signal();
    await stub.flush();
    await wait(LEASE_DURATION_MS + MARGIN_MS);
    expect((await stub.status()).state).toBe("exhausted");
    expect(await stub.getRunCount()).toBe(1);

    // A signal() here must not fall through to the debounce path: that would arm an alarm which
    // matches no branch in alarm(), silently deleting itself while the caller believes a run is
    // scheduled. It stays exhausted, with the signal queued for a late finishClaim().
    const afterSignal = await stub.signal();
    expect(afterSignal.state).toBe("exhausted");
    expect(afterSignal.coalescedPending).toBe(true);

    const afterFlush = await stub.flush();
    expect(afterFlush.state).toBe("exhausted");

    // Nothing fires, however long we wait: an exhausted key is terminal until cancel().
    await wait(LEASE_DURATION_MS * 3);
    expect(await stub.getRunCount()).toBe(1);
    expect((await stub.status()).state).toBe("exhausted");
  });

  it("returns an exhausted key to idle if its abandoned run() finally settles for real", async () => {
    const { stub } = freshStub();
    await stub.setRunBehavior("slow"); // sleeps 150ms, outliving the 80ms lease
    await stub.setMaxReclaims(0); // exhaust on the very first expiry, mid-run

    await stub.signal();
    await stub.flush();
    await wait(LEASE_DURATION_MS + MARGIN_MS);
    expect((await stub.status()).state).toBe("exhausted");

    // Exhaustion leaves claimEpoch untouched, so when the abandoned run finally finishes its
    // own finishClaim() still matches and cleans the key up rather than stranding it.
    await wait(200);
    expect((await stub.status()).state).toBe("idle");
  });

  it("cancel() unsticks an exhausted key and lets a fresh cycle run normally afterward", async () => {
    const { stub } = freshStub();
    await stub.setRunBehavior("hang");
    await stub.setMaxReclaims(0); // give up on the very first lease expiry, no reclaim at all

    await stub.signal();
    await stub.flush();
    expect(await stub.getRunCount()).toBe(1);

    await wait(LEASE_DURATION_MS + MARGIN_MS);
    expect((await stub.status()).state).toBe("exhausted"); // gave up on the 1st expiry
    expect(await stub.getExhaustedEvents()).toHaveLength(1);

    const cancelled = await stub.cancel();
    expect(cancelled.state).toBe("idle");

    await stub.setRunBehavior("succeed");
    await stub.signal();
    await stub.flush();
    expect(await stub.getRunCount()).toBe(2);
    expect((await stub.status()).state).toBe("idle");
  });
});

describe("fencing your own side effects", () => {
  it("isCurrentEpoch() reflects whether a run has been superseded by a reclaim", async () => {
    const { stub } = freshStub();
    await stub.setRunBehavior("slow"); // sleeps 150ms — longer than the 80ms lease

    await stub.signal();
    await stub.flush(); // epoch 1 claims and starts its 150ms sleep
    await stub.setRunBehavior("succeed"); // epoch 2's reclaim, if any, finishes instantly instead

    // Let epoch 1's lease expire; the platform's own alarm reclaims into epoch 2, which reads
    // "succeed" and finishes well within its own lease — no cascade into a 3rd claim.
    await wait(LEASE_DURATION_MS + MARGIN_MS);
    expect(await stub.getRunCount()).toBe(2);

    // Epoch 1's sleep (started at t=0, unaffected by being superseded) finishes ~150ms in; wait
    // past that so it gets the chance to record its isCurrentEpoch() check.
    await wait(150);

    expect(await stub.getEpochChecks()).toEqual([false]); // epoch 1 found itself superseded
    expect((await stub.status()).state).toBe("idle");
  });
});

describe("failure handling", () => {
  it("reports a thrown run() via onRunError and still returns to idle and stays eligible", async () => {
    const { stub } = freshStub();
    await stub.setRunBehavior("throw");

    await stub.signal();
    await stub.flush();
    await wait(MARGIN_MS);

    expect(await stub.getRunCount()).toBe(1);
    expect(await stub.getErrors()).toEqual(["test-induced failure"]);
    expect((await stub.status()).state).toBe("idle");

    await stub.setRunBehavior("succeed");
    await stub.signal();
    await stub.flush();
    expect(await stub.getRunCount()).toBe(2);
    expect((await stub.status()).state).toBe("idle");
  });

  it("reports a failed re-arm of a coalesced re-trigger via onRunError instead of dropping it silently", async () => {
    const { stub } = freshStub();
    await stub.setRunBehavior("hang");

    await stub.signal();
    await stub.flush();
    expect(await stub.getRunCount()).toBe(1);

    const coalesced = await stub.signal();
    expect(coalesced.coalescedPending).toBe(true);

    // Let the reclaim's own setAlarm (1st call) through, then fail the coalesced signal()'s
    // setAlarm (2nd call) — the exact re-trigger path finishClaim() drives after a run completes.
    await stub.sabotageSetAlarmAfter(1);
    await stub.setRunBehavior("succeed");

    // Rely on the platform's own alarm scheduler firing once the lease expires, rather than also
    // forcing a runDurableObjectAlarm() nudge like the "coalescing" tests do: the sabotaged
    // setAlarm() leaves the key stuck in "pending" with no real alarm actually scheduled, so a
    // forced alarm check here would find that stale deadline already passed and kick off an
    // unrelated third claim — it isn't the harmless no-op it is once a cycle settles cleanly. The
    // reclaim's own lease alarm is still armed for another LEASE_DURATION_MS beyond this, and
    // *that* one firing would trigger the same unwanted third claim, so keep this wait well short
    // of it rather than long enough to "fully settle".
    await wait(LEASE_DURATION_MS + MARGIN_MS);

    expect(await stub.getRunCount()).toBe(2); // the reclaim's own run still executed
    expect(await stub.getErrors()).toEqual(["simulated setAlarm failure"]);
  });

  it("still returns to idle promptly when the onRunError callback itself throws", async () => {
    const { stub } = freshStub();
    await stub.setRunBehavior("throw");
    await stub.setOnRunErrorThrows(true);

    await stub.signal();
    await stub.flush();
    await wait(MARGIN_MS);

    // The thrown-inside-onRunError case is exactly what used to skip finishClaim(): without the
    // fix this stays "claimed" until the lease alarm intervenes, ~LEASE_DURATION_MS later.
    expect((await stub.status()).state).toBe("idle");
    expect(await stub.getErrors()).toEqual(["test-induced failure"]);
  });

  it("still gives up exactly once when the onExhausted callback itself throws", async () => {
    const { stub } = freshStub();
    await stub.setRunBehavior("hang");
    await stub.setMaxReclaims(0);
    await stub.setOnExhaustedThrows(true);

    await stub.signal();
    await stub.flush();
    expect(await stub.getRunCount()).toBe(1);

    // Without the fix, a throwing onExhausted escapes alarm() itself, which the platform retries
    // with its own backoff independent of leaseDurationMs — empirically, the first retry lands
    // 2-3s in and pushes the call count to 2. Wait past that (with margin) to give a retry-storm
    // a real chance to show up, then confirm it only ever fired once.
    await wait(4_000);

    expect(await stub.getRunCount()).toBe(1); // no reclaim: gave up on the very first expiry
    expect(await stub.getOnExhaustedCallCount()).toBe(1);
    expect((await stub.status()).state).toBe("exhausted"); // terminal, as documented

    // The DO itself must still be alive and responsive after the callback's own failure.
    await stub.setOnExhaustedThrows(false);
    expect((await stub.cancel()).state).toBe("idle");
  });
});

describe("manual bypass", () => {
  it("does nothing if nothing is pending and nothing is running", async () => {
    const { stub } = freshStub();
    await stub.setRunBehavior("succeed");

    const status = await stub.flush();

    expect(await stub.getRunCount()).toBe(0);
    expect(status.state).toBe("idle");
  });

  it("runs a pending signal() immediately, without waiting for the quiet period", async () => {
    const { stub } = freshStub();
    await stub.setRunBehavior("succeed");

    await stub.signal();
    await stub.flush();

    expect(await stub.getRunCount()).toBe(1);
  });

  it("does not double-run if one is already in flight", async () => {
    const { stub } = freshStub();
    await stub.setRunBehavior("hang");

    await stub.signal();
    await stub.flush();
    const status = await stub.flush();

    expect(await stub.getRunCount()).toBe(1);
    expect(status.state).toBe("claimed");
    expect(status.coalescedPending).toBe(true);
  });
});

describe("observability", () => {
  it("reports idle / pending / claimed with timestamps across the full lifecycle", async () => {
    const { stub } = freshStub();
    await stub.setRunBehavior("succeed");

    const idle = await stub.status();
    expect(idle.state).toBe("idle");
    expect(idle.since).toBeUndefined();

    const beforeSignal = Date.now();
    const pending = await stub.signal();
    if (pending.state !== "pending") throw new Error("expected pending status");
    expect(pending.since).toBeGreaterThanOrEqual(beforeSignal);
    expect(pending.debounceDeadline).toBeGreaterThan(pending.since);

    await wait(QUIET_PERIOD_MS + MARGIN_MS);
    await runDurableObjectAlarm(stub);

    const afterRun = await stub.status();
    if (afterRun.state !== "idle" || afterRun.since === undefined) {
      throw new Error("expected idle status with a since timestamp");
    }
    expect(afterRun.since).toBeGreaterThanOrEqual(pending.since);
  });
});

describe("coalescing", () => {
  // These tests drive completion of an in-flight run via the lease-expiry reclaim path rather
  // than by resolving the original run() in place: the platform's alarm scheduler fires for
  // real as wall-clock time passes (independent of the runDurableObjectAlarm helper, which just
  // forces a check early/deterministically), so once the lease expires the abandoned "hang" run
  // is reclaimed and a second, fast-completing run is what actually resolves the coalesced
  // signal. Because that scheduler keeps advancing autonomously in the background, these tests
  // assert the final settled outcome after a generous combined wait rather than trying to catch
  // an exact intermediate state — the intermediate state is real but too fleeting to pin down
  // deterministically against a live scheduler without flaking.

  it("queues a plain signal() during an in-flight run and restarts a fresh debounce window", async () => {
    const { stub } = freshStub();
    await stub.setRunBehavior("hang");

    await stub.signal();
    await stub.flush();
    expect(await stub.getRunCount()).toBe(1);
    expect((await stub.status()).state).toBe("claimed");

    const coalesced = await stub.signal();
    expect(coalesced.state).toBe("claimed"); // still claimed — signal() didn't start a new run
    expect(coalesced.coalescedPending).toBe(true);
    expect(await stub.getRunCount()).toBe(1); // still just the one (abandoned) in-flight run

    // Let the lease expire (reclaim -> a fast "succeed" run resolves the coalesced signal ->
    // fresh debounce window -> that run fires too): 1 (abandoned) + 1 (reclaim) + 1 (coalesced).
    await stub.setRunBehavior("succeed");
    await wait(LEASE_DURATION_MS + QUIET_PERIOD_MS + MARGIN_MS * 2);
    await runDurableObjectAlarm(stub); // safety-net nudge; harmless if already settled naturally

    expect(await stub.getRunCount()).toBe(3);
    const final = await stub.status();
    expect(final.state).toBe("idle");
    expect(final.coalescedPending).toBeFalsy();
  });

  it("fires a coalesced flush() immediately once the in-flight run completes, without a debounce wait", async () => {
    const { stub } = freshStub();
    await stub.setRunBehavior("hang");

    await stub.signal();
    await stub.flush();
    expect(await stub.getRunCount()).toBe(1);

    const coalesced = await stub.flush();
    expect(coalesced.state).toBe("claimed");
    expect(coalesced.coalescedPending).toBe(true);
    expect(await stub.getRunCount()).toBe(1);

    // Let the lease expire: the reclaim's own run completes, and finishClaim() immediately
    // re-claims again for the coalesced flush() — no debounce wait involved.
    await stub.setRunBehavior("succeed");
    await wait(LEASE_DURATION_MS + MARGIN_MS);
    await runDurableObjectAlarm(stub);
    await wait(MARGIN_MS);

    // 1 (abandoned hang) + 1 (reclaim) + 1 (immediate coalesced re-run) = 3.
    expect(await stub.getRunCount()).toBe(3);
    expect((await stub.status()).state).toBe("idle");
    expect((await stub.status()).coalescedPending).toBeFalsy();
  });
});
