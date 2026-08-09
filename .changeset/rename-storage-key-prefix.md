---
"@samstarling/cloudflare-utils-debounce": minor
---

Rename the reserved storage key prefix from `__dbl:` to `__debounce:`, matching the package name.

This is a breaking change to on-disk state, and there is no migration. A Durable Object holding state written by 0.1.0 keeps it under `__dbl:`, while this version reads and writes `__debounce:`, so an upgraded key looks unwritten: a `pending` or `claimed` key loses its deadline and lease, and its next `alarm()` throws an invariant error instead of resuming.

Upgrade while keys are idle, or call `cancel()` on anything in flight first. Subclasses only need to keep clear of the new prefix.
