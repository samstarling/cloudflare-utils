// mulberry32, a small seeded PRNG. Shared by chaos.spec.ts and chaos-do.ts so a seed means the
// same thing on both sides of the RPC boundary.

export function mulberry32Step(state: number): { value: number; nextState: number } {
  const a = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, nextState: a };
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    const { value, nextState } = mulberry32Step(state);
    state = nextState;
    return value;
  };
}
