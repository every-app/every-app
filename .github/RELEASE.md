# Release Process

Publishing is paused while we work from the repository: nothing goes to npm,
and nothing is synced to the public repository. `everyapp` and
`@every-app/sdk` are private packages. The apps take them from the workspace,
and the CLI builds the gateway from its own checkout for every deploy
(`packages/cli/src/commands/gateway/shared.ts`). How to work this way is in
the README, under "Work from This Checkout".

## Turning publishing back on

Pausing removed what only a published CLI needs. Bring back:

- **Publishing itself:** drop `"private": true` from `packages/cli/package.json`
  and `packages/sdk/package.json`, and restore their pack scripts. The SDK
  had `prepack` and `prepublishOnly`. The CLI had `prepack`, which
  type-checked, built, and ran `scripts/bundle-gateway.js` (the gateway
  release tarball and its `release.json`, into `packages/cli/gateway/`) and
  `scripts/bundle-templates.js` (`templates/simple-todo`, into
  `packages/cli/templates/`, its `.gitignore` shipped as `gitignore`).
- **The CLI's use of that bundle:** the gateway release resolved as
  `--release`, then the bundled tarball, then a build from the checkout.
  Reconcile fell back to the bundled release when the live one wasn't cached
  in KV, and `gateway status` compared the live release with it.
- **Onboarding:** `everyapp setup` deployed a starter app (`--dir`,
  `--no-starter`), and `app create` copied the bundled template, or cloned
  the public repository for it.
- **The cloneable apps and the template:** `@every-app/sdk` by semver range
  (with `linkWorkspacePackages: true` at the root), their own
  `pnpm-workspace.yaml` with `allowBuilds` for standalone installs, and
  `npx -y everyapp@latest` in their scripts.
- **Words:** `npx everyapp …` in the CLI's and the gateway's hints, the npm
  update check (`packages/cli/src/lib/version-check.ts`), and the README's
  install steps (`npx everyapp setup`, `gitpick` for the examples).

All of it is in the git history of the change that paused publishing (#276).

Then publish the SDK first, then the CLI, and only then sync the public
repository: the cloneable apps reference versions that must already exist
on npm. Before publishing the CLI, `cd packages/cli && npm pack --dry-run`
must list `dist/index.js`, `gateway/every-app-gateway-release.tar.gz` and
`gateway/release.json`, and no `.dev.vars` or `.env*` entries.
