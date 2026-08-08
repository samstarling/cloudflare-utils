# Changesets

This folder holds pending changesets: one markdown file per unreleased change, each recording which package changed, at what semver level, and why. [Changesets](https://github.com/changesets/changesets) consumes them to work out version bumps and generate the changelog.

## Adding one

Every user-facing change to a published package needs a changeset. Run `bun run changeset`, pick the package and bump level, write a one-line summary aimed at someone upgrading, and commit the generated file alongside your change.

Each package is versioned and released independently, so one changeset should name only the packages it actually affects. A change touching two packages either names both (with a bump level each) or gets two changesets — never one bump standing in for the other.

Bump levels: `patch` for fixes that don't alter the documented contract, `minor` for new config options or methods, `major` for anything that changes a documented guarantee, observable behaviour, or an existing signature.

Changes that need no changeset: tests, CI, docs, and anything under `examples/`. Examples are `private`, and `privatePackages.version` is `false` in `config.json`, so they're never versioned or published.

## Releasing

CI handles it. On a push to `main`, the release workflow opens (or updates) a "Version Packages" PR that consumes every pending changeset, bumps each affected package and writes its `CHANGELOG.md`. Merging that PR publishes to npm with provenance. Nothing is published while changesets are still pending, so an unmerged Version Packages PR is the normal steady state between releases.
