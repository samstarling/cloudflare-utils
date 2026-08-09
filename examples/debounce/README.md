# cloudflare-utils-debounce — example

A full-stack Cloudflare Worker demonstrating
[`@samstarling/cloudflare-utils-debounce`](../../packages/debounce) end to end:
signal → debounce → exclusive run → observe state. A small React dashboard (`src/client/`) drives
the same API a real consumer would use, so you can watch the state machine live instead of
reading JSON.

The example resolves `@samstarling/cloudflare-utils-debounce` through a workspace symlink into
[`packages/debounce`](../../packages/debounce), so that package's `dist/` has to exist first:

```sh
bun install         # from the repo root
bun run build       # builds packages/*, which this example imports
cd examples/debounce
bun run dev
```

Open the printed URL (e.g. `http://localhost:5173`). Type a key (or keep "acme"), then:

- **Send signal** repeatedly — watch the badge go `PENDING` and the countdown reset each time.
- Stop sending signals and wait out the countdown — it flips to `CLAIMED` then back to `IDLE`
  as `run()` fires exactly once, logged in the Activity list below.
- Keep signalling for more than 20s without stopping — the countdown stops resetting and it runs
  anyway. That's the `maxWaitMs: 20_000` ceiling in `src/do.ts`; without it a key signalled faster
  than the 5s quiet period would never run at all.
- **Flush now** bypasses the debounce wait entirely, any time.

The Activity list shows both state transitions and each `run()`'s start and finish, with how
long it took. This example's `run()` deliberately sleeps for a random 0–10s against a 5s lease,
so some runs outlast their lease and get superseded by a reclaim — those are logged in red as
`superseded`, with the side effect skipped by the `isCurrentEpoch(epoch)` guard in `src/do.ts`.
Keep signalling and you'll see one within a few runs.

The dashboard is just a thin client over the same HTTP API a non-UI consumer would call
directly — useful if you'd rather drive it from a terminal instead:

```sh
curl -X POST http://localhost:5173/api/acme/signal
curl http://localhost:5173/api/acme/status
curl -X POST http://localhost:5173/api/acme/flush
curl http://localhost:5173/api/acme/runs    # this example's own run history
```

Watch the terminal running `bun run dev` for `[ExampleDebounceAndLease] running action for key
"acme"` — that's `run()` firing, at most once at a time, no matter how many signals you send.

## Structure

- `src/worker.ts` — the Worker's API (`/api/:key/signal`, `/api/:key/flush`, `/api/:key/status`,
  `/api/:key/runs`), everything else falls through to the static frontend.
- `src/do.ts` — `ExampleDebounceAndLease`, the concrete subclass wired up with real config. It
  also keeps its own run history under `example:`-prefixed storage keys, clear of the library's
  reserved `__debounce:` prefix: the library reports the state machine via `status()`, not per-run
  outcomes, so tracking those is a consumer's job.
- `src/shared.ts` — types shared by the Worker and the browser bundle.
- `src/client/` — the React dashboard, built and dev-served by
  [`@cloudflare/vite-plugin`](https://developers.cloudflare.com/workers/vite-plugin/) alongside
  the Worker in a single `vite dev`/`vite build`.

## Deploying

`bun run deploy` builds the frontend and Worker together, then runs `wrangler deploy`. You'll
need your own Cloudflare account authenticated via `wrangler login` first.
