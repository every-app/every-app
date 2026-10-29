# TODO

The maintainers keep their working TODO in their own repository: it names their
Cloudflare account, their dogfood Gateway and the scratch copies of the apps.
This is the public part: the decisions that shape what you see, each shipped
with a default. The docs at https://everyapp.com/docs describe the defaults,
and [docs/threat-model.md](docs/threat-model.md) says what is promised and
what is still open.

## Decide

- [x] **The license holder.** Ben (2026-10-24): "Every App, Inc." Applied. `LICENSE` is MIT, copyright "Every App contributors".
- [ ] **Password accounts and Cloudflare Access.** A password account connects
      Access by signing in once through it; after that Access signs it in.
- [ ] **MCP defaults.** OAuth on, dynamic client registration on with limits
      (`MCP_OAUTH_ENABLED`, `MCP_DCR_ENABLED`).
- [ ] **Destructive tools stay hidden from AI clients** until approvals exist.
- [ ] **Deployer access needs a verified e-mail.** On a password-only Gateway,
      "private to you" means owners and admins only; with Access it narrows to you.
- [ ] **`deploy --yes` installs a Gateway at `apps.<zone>` without asking**,
      `--no-wait` skips the live wait, the inline install waits for the owner.
- [ ] **The Gateway app install is a second deploy authority.** With `CF_DEPLOY_TOKEN`
      set, an owner or admin can have the Gateway install a public release
      (`BROWSER_APP_INSTALLS`); see docs/threat-model.md.
- [ ] **npm.** Publishing is paused: `pnpm everyapp` from this checkout, never
      `npx everyapp`. The old packages on npm predate the October security work.

## Build

- [ ] Approvals for destructive tools, by browser link.
- [ ] Standalone apps: `starter/package.json` depends on `workspace:*`, so an app
      pushed to its own repository can't `pnpm install` outside this checkout
      until the SDK and CLI are published.
- [ ] Teams beyond one organization per Gateway; usage limits per organization.

No backwards-compatibility promise yet: when something must change, the
release notes say so.
