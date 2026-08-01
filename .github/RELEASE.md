# Release Process

## Gateway

The gateway is **not** released separately. It ships inside the `everyapp` npm
package: `prepack` builds the SDK, runs the gateway's `build:release`,
and copies the tarball into `packages/cli/gateway/`
(see `packages/cli/scripts/bundle-gateway.js`). `prepack` fires on both
`npm pack` and `npm publish`, so a pack can't ship a stale or missing bundle.

So the CLI version and the gateway version are the same thing, and rolling back
means installing an older CLI.

`everyapp gateway deploy` resolves the gateway in this order:

1. `--localGateway <tarball>` — a prebuilt tarball passed explicitly
2. the tarball bundled in the installed CLI package — what a user gets
3. building from `apps/every-app-gateway`, found by walking up from the current
   directory — what you get inside this monorepo

The tarball is a build artifact, gitignored, and regenerated at publish time.

## Publishing

Publish the SDK first — the cloneable apps and templates depend on
`@every-app/sdk` by published semver range, so the range must resolve on npm
before anyone installs a clone that declares it.

```bash
pnpm --filter @every-app/sdk publish
pnpm --filter everyapp publish
```

**Order matters beyond the two packages: publish to npm _before_ syncing the
public repo.** The cloneable packages reference `@every-app/sdk` and `everyapp`
versions that must exist on npm — a public sync ahead of the publish gives
cloners a `pnpm install` that fails on unresolvable versions.

Before publishing the CLI, confirm the package actually contains the gateway:

```bash
cd packages/cli && npm pack --dry-run
```

`dist/index.js` and `gateway/every-app-gateway-build.tar.gz` must both be
listed — the deploy resolves the tarball relative to `dist/`, so a package
missing either one fails for anyone outside this monorepo. Also confirm the
listing contains **no `.dev.vars` or `.env*` entries** (the gateway build
fails closed on these, but check).

## Troubleshooting

**Build fails during `bundle-gateway.js`:** verify the gateway builds on its own
first.

```bash
cd apps/every-app-gateway && pnpm run build:release
```

**`gateway deploy` says it can't find the gateway source:** you're outside the
monorepo with a CLI that has no bundled tarball — i.e. a package published
without `prepublishOnly` running. Re-publish, or pass `--localGateway`.
