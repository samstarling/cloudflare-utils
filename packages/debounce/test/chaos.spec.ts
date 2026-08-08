import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CHAOS_LEASE_DURATION_MS, type ChaosRecord } from "./fixtures/chaos-do";
import { mulberry32 } from "./fixtures/prng";
import { wait } from "./fixtures/wait";

// Many concurrent clients hammer signal()/flush() across several keys, occasionally evicting the
// Durable Object mid-flight, while each run() randomly succeeds, throws, or "crashes" (never
// resolves). Every execution records its start/end (see chaos-do.ts); the checker below asserts
// no two executions on the same key ever overlap, except when the later one started at or after
// the earlier one's lease deadline.
//
// Randomness is seeded (fixtures/prng.ts) and every run logs its seed — set SEED_OVERRIDE to
// replay one, though real timer jitter means this narrows a failure down rather than reproducing
// it exactly.

const KEY_COUNT = 3;
const CLIENTS_PER_KEY = 4;
const OPERATIONS_PER_CLIENT = 10;
const EVICTION_PROBABILITY = 0.15;

const SEED_OVERRIDE: number | undefined = undefined;
const SEED = SEED_OVERRIDE ?? Date.now() >>> 0;

interface Overlap {
  key: string;
  a: ChaosRecord;
  b: ChaosRecord;
}

// Absorbs the lag between the library's real lease deadline and a.startedAt (recorded slightly
// later, once run() actually fires). Well under the shortest injected overlap, so it can't hide
// a genuine violation.
const MEASUREMENT_TOLERANCE_MS = 10;

// Finds same-key execution windows that overlap without the later one starting at/after the
// earlier one's lease deadline — i.e. a genuine violation of the exclusivity guarantee.
function findIllegalOverlaps(key: string, records: ChaosRecord[]): Overlap[] {
  const sorted = [...records].sort((a, b) => a.startedAt - b.startedAt);
  const violations: Overlap[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    if (!a) continue;
    const aEnd = a.endedAt ?? Number.POSITIVE_INFINITY; // no recorded end = crashed/still "open"
    const aLeaseDeadline = a.startedAt + CHAOS_LEASE_DURATION_MS - MEASUREMENT_TOLERANCE_MS;

    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      if (!b) continue;
      if (b.startedAt >= aEnd) break; // sorted by start; once b starts after a ends, so do all later b's
      if (b.startedAt < aLeaseDeadline) {
        violations.push({ key, a, b });
      }
    }
  }
  return violations;
}

async function chaosClient(
  stub: ReturnType<typeof env.CHAOS_DEBOUNCE.getByName>,
  rng: () => number,
): Promise<void> {
  for (let i = 0; i < OPERATIONS_PER_CLIENT; i++) {
    if (rng() < EVICTION_PROBABILITY) {
      // Not awaited: can hang forever if it collides with a "crash" run() that never resolves.
      evictDurableObject(stub).catch(() => {});
    }
    if (rng() < 0.25) {
      await stub.flush();
    } else {
      await stub.signal();
    }
    await wait(Math.floor(rng() * 10));
  }
}

describe("chaos", () => {
  it("never allows an unjustified overlapping execution across many concurrent chaotic clients", async () => {
    console.log(
      `chaos seed: ${SEED} (set SEED_OVERRIDE = ${SEED} in chaos.spec.ts to replay this run)`,
    );
    const rootRng = mulberry32(SEED);
    const nextSeed = () => Math.floor(rootRng() * 0x100000000);

    const keys = Array.from(
      { length: KEY_COUNT },
      (_, i) => `chaos-${i}-${nextSeed().toString(36)}`,
    );
    const stubs = keys.map((key) => env.CHAOS_DEBOUNCE.getByName(key));
    await Promise.all(stubs.map((stub) => stub.seed(nextSeed())));

    const clients = stubs.flatMap((stub) =>
      Array.from({ length: CLIENTS_PER_KEY }, () => chaosClient(stub, mulberry32(nextSeed()))),
    );
    await Promise.all(clients);

    // Let any straggling debounce/lease cycles settle before reading final history.
    await wait(CHAOS_LEASE_DURATION_MS * 4);
    for (const stub of stubs) {
      await runDurableObjectAlarm(stub).catch(() => {}); // no-op if nothing is scheduled
    }
    await wait(CHAOS_LEASE_DURATION_MS * 2);

    const allViolations: Overlap[] = [];
    for (const [i, stub] of stubs.entries()) {
      const history = await stub.getHistory();
      // Sanity check: the chaos actually drove executions, not a no-op test.
      expect(history.length).toBeGreaterThan(0);
      allViolations.push(...findIllegalOverlaps(keys[i] ?? `chaos-${i}`, history));
    }

    expect(allViolations).toEqual([]);
  });
});
