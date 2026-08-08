# cloudflare-utils

A monorepo of small, focused libraries for Cloudflare Workers and Durable Objects. Each package solves one problem, and is versioned and published independently as `@samstarling/cloudflare-utils-<name>`.

There's one so far, `debounce`; more will follow.

## Packages

| Package                                    | npm                                                                                                              | What it does                                                                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [`packages/debounce`](./packages/debounce) | [`@samstarling/cloudflare-utils-debounce`](https://www.npmjs.com/package/@samstarling/cloudflare-utils-debounce) | Collapses a burst of events into a single, globally-exclusive, crash-recoverable action per key, on Durable Objects alone. |

## Examples

Each example is a deployable Worker exercising one package end to end:

- [`examples/debounce`](./examples/debounce): a full-stack demo of `@samstarling/cloudflare-utils-debounce`, with a React dashboard for watching the state machine live.

## Contributing

```sh
bun install
bun run lint
bun run typecheck
bun run test
bun run build
```

The root scripts fan out across every package in `packages/*`, so they pick up new packages without changes here. `typecheck` builds the packages first, since each example imports its dependency through a workspace symlink and so needs that `dist/` to exist.

Every user-facing change to a published package needs a changeset. See [`.changeset/README.md`](./.changeset/README.md) for how versioning and releases work. Run `bun run changeset` (interactive), and commit the generated file alongside your change.
