---
"@samstarling/cloudflare-utils-debounce": minor
---

Make driving a long-running action (such as a Cloudflare Workflow) from `run()` easier and safer.

- **`run()` now receives an `AbortSignal`** as its third argument: `run(key, epoch, signal)`. It fires at the new `runTimeoutMs` config option, or at `leaseDurationMs` when that's unset. Forward it into whatever `run()` awaits — a `fetch`, a workflow-status poll, an LLM call — so an overrunning run is torn down at its budget rather than left spinning until the lease reclaims it. This is a signature change, but a subclass whose `run()` ignores the third argument is unaffected.
- **`flush()` now recovers an `exhausted` key** instead of queuing behind it: it resets the given-up key and starts a fresh cycle. A cron reconciler can now call `flush()` unconditionally to unstick a key whose action died `maxReclaims` times, without first inspecting for the terminal state or calling `cancel()`. A plain `signal()` on an exhausted key still queues, as before.
- **New `runTimeoutMs` config option** controls when the `AbortSignal` fires. Optional; must be positive and no greater than `leaseDurationMs`.

The README gains a "Driving a Cloudflare Workflow" section covering the three things that keep the exclusivity and at-least-once guarantees intact: `run()` must block until the workflow is finished (not just created), the instance ID must be deterministic and created idempotently via `createBatch`, and the DB — backed by a `flush()`-based reconciler — stays the source of truth for staleness.
