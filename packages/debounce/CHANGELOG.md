# @samstarling/cloudflare-utils-debounce

## 0.2.0

### Minor Changes

- 5051f2f: Rename the reserved storage key prefix from `__dbl:` to `__debounce:`, matching the package name.

  This is a breaking change to on-disk state, and there is no migration. A Durable Object holding state written by 0.1.0 keeps it under `__dbl:`, while this version reads and writes `__debounce:`, so an upgraded key looks unwritten: a `pending` or `claimed` key loses its deadline and lease, and its next `alarm()` throws an invariant error instead of resuming.

  Upgrade while keys are idle, or call `cancel()` on anything in flight first. Subclasses only need to keep clear of the new prefix.

## 0.1.0

### Minor Changes

- c322733: Initial public release.

  Collapses a burst of events into a single downstream action per key, running at most once at a time globally on Cloudflare Durable Objects alone. Subclass `DebounceAndLease`, implement `run()`, and drive it with `signal()`, `flush()`, `status()` and `cancel()`.

  Events are debounced by key, where the key is the Durable Object's own id name — so pick it as the unit of _output_ (the thing being regenerated), not the unit of input that triggered it. Optional `maxWaitMs` caps how long a key may stay pending before running anyway, measured from the signal that first made it pending; without it, a key signalled more often than once per `quietPeriodMs` has its deadline pushed out indefinitely and never runs. Storage keys under `__debounce:` are reserved for the library, so subclasses sharing the same `storage.kv` should namespace their own.

  Retries are lease-driven rather than error-driven: a `run()` that throws is not retried, while one that hangs or is silently killed is reclaimed once its lease expires. `maxReclaims` caps that at 10 by default (exported as `DEFAULT_MAX_RECLAIMS`, set `Infinity` to retry forever), so a permanently hanging action can't reclaim indefinitely. Once the cap is exceeded the key moves to the terminal `"exhausted"` state, distinct from `"claimed"` because no lease is live there and nothing will move the key on its own until `cancel()` resets it. `run()` receives an `epoch` so callers can fence their own side effects against a superseded invocation via `isCurrentEpoch()`.
