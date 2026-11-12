# OAuth simplify: what merged, what to check, how to deploy

Date: 2026-11-02. For Ben. The plan is [2026-11-oauth-simplify.md](2026-11-oauth-simplify.md); the wider audit is [2026-11-simplify-audit.md](2026-11-simplify-audit.md).

On 2026-11-10, [2026-11-oauth-one-connection.md](2026-11-oauth-one-connection.md) replaced the per-app connections this document describes with one connection per person per provider.

## Merged

| Repo              | PR                    | Commit   | What                                                                             |
| ----------------- | --------------------- | -------- | -------------------------------------------------------------------------------- |
| private-every-app | #939                  | e8c4b44e | Proposal + `/docs/google-personal-accounts`                                      |
| private-every-app | #940                  | 500fba5c | Prettier fix for the docs page (its `pack-for-app --vendor` was removed in #944) |
| private-every-app | #941                  | cc673523 | Simplification audit (docs only)                                                 |
| private-every-app | #942                  | aaddc038 | The OAuth change, `CHANGELOG.md`                                                 |
| private-open-mail | #19 (into `everyapp`) | 6d35b5a8 | Gmail on the new model                                                           |
| private-open-crm  | #22                   | fa914c36 | Mail through the Gateway; CRM holds no tokens                                    |
| private-open-seo  | #1163                 | 702935e3 | Per-member Google connections                                                    |
| private-every-app | #944                  | 673bed8c | Never vendor the SDK or CLI into an app; `pnpm link` for local dev               |
| private-every-app | #949                  | 1ea732ef | `PUBLISHED_VERSION` 0.3.0-rc.11 (on npm; Gateway release `gateway-v0.3.0-rc.11`) |
| private-open-mail | #20                   | 08da9019 | Pin 0.3.0-rc.11 from npm                                                         |
| private-open-crm  | #23                   | 9989f878 | Pin 0.3.0-rc.11 from npm                                                         |
| private-open-seo  | #1167                 | eb41a238 | Pin 0.3.0-rc.11 from npm                                                         |

All three apps pin the published `@every-app/sdk` and `everyapp` 0.3.0-rc.11 from npm. Nothing is vendored (the rule is in AGENTS.md).

## What changed

- An OAuth entry is `{ scopes, why }`, with the provider's own scope names.
- People connect in each app. A connection is one person's, for one app.
- The app uses it any time, including in the background, with `for: { background: true, userId }`.
- The Gateway refuses any token with scopes beyond the config, at connect and at refresh.
- Deleted:
  - background grants and the idle lapse;
  - scope sets and URL/method rules;
  - overlays and `provider scope-set`;
  - organization connections;
  - Google, Microsoft and Slack code (they are JSON specs now);
  - the flow where an app held its own tokens;
  - the 12 social-network presets.

## Decisions I took; check these

1. **Read-only agents can now write through OAuth.** The Gateway no longer blocks it. The tool-level read/write split still applies. Security review flagged it as medium; kept per your delete list.
2. **Slack uses the bot token only.** No app uses Slack.
3. **Social presets are deleted** (X, LinkedIn, YouTube, …). Postiz isn't launching.
4. **OpenSEO reads use the connection of the member who picked the property.** Other members see the same data.
5. **CRM's old token columns are emptied, not dropped.** CRM's migration rules forbid dropping columns in one release. The drop is a TODO.
6. **A temporary install exception.** CRM and OpenSEO exempt `@inquirer/*` 8.7.5 (a dependency of the rc.11 CLI) from `minimumReleaseAge`. Remove it after 2026-11-04.
7. **The general deletion lane (L5) produced nothing.** It was interrupted. The audit covers the same ground, ranked.
8. **#912 (`birds/feature`) needs a rebase.** It must drop #902/#921/#923/#924/#929, take #942's OAuth files and renumber its migrations from 0026.

## Proposed next deletions (L1)

- Built-in Slack, and built-in Microsoft once nothing needs it.
- Make Google a preset; drop the built-in vs preset distinction.
- Drop provider-side revoke on disconnect.
- Keep OAuth clients only in Gateway settings (drop the UI-pasted store).

## Deploy to everyapp.team

**Done 2026-11-03.** Ben deployed the Gateway from the `gateway-v0.3.0-rc.11` release, then OpenSEO, CRM and OpenMail; `agentic-inbox` is deleted. The app CLI (from npm) only updates a Gateway to a published release, so the order was: push `1ea732ef2` to public main and tag `gateway-v0.3.0-rc.11`, then `pnpm exec everyapp update` from an app checkout, then `pnpm exec everyapp deploy` in each app. The steps below are kept as written before the deploy.

Downtime: OpenSEO's Google cards and CRM's mail sync stop between step 2 and their redeploys. Do steps 2–5 together.

**1. Before you start (consoles).**

- Google Cloud project of the `google-workspace` client:
  - Data Access: add `gmail.modify` and `gmail.send` (OpenMail);
  - keep `gmail.readonly`, `calendar.readonly`, `webmasters.readonly` and `analytics.readonly`;
  - turn on the Gmail API if it isn't on;
  - if people use personal @gmail.com accounts, see `/docs/google-personal-accounts`.
- Microsoft Entra app of `microsoft-365`: add the redirect URI `https://everyapp.team/connect/microsoft-365/callback`. CRM used its own callback before.
- Google's redirect URI `https://everyapp.team/connect/google-workspace/callback` should already be there (OpenSEO used it).
- `cf auth login` with access to account `23bc28f0b638fbfc1c7f838573c17ee3`.

**2. Gateway** (runs migration 0025 and prints a restore bookmark; save it).

```sh
git -C ~/workspaces/private-every-app fetch origin
git -C ~/workspaces/private-every-app worktree add --detach /tmp/ea-deploy/pea origin/main
cd /tmp/ea-deploy/pea && pnpm install
pnpm everyapp update --gateway https://everyapp.team --account-id 23bc28f0b638fbfc1c7f838573c17ee3
pnpm everyapp provider list --gateway https://everyapp.team   # a provider added from a preset: re-add with `provider add --oauth <preset> --replace`
```

**3. OpenSEO.**

```sh
git -C ~/workspaces/open-seo fetch origin
git -C ~/workspaces/open-seo worktree add --detach /tmp/ea-deploy/openseo origin/main
cd /tmp/ea-deploy/openseo && pnpm install --frozen-lockfile
pnpm exec everyapp deploy --gateway https://everyapp.team --account-id 23bc28f0b638fbfc1c7f838573c17ee3
```

**4. CRM**, then remove its old encryption key.

```sh
git -C ~/workspaces/open-crm fetch origin
git -C ~/workspaces/open-crm worktree add --detach /tmp/ea-deploy/crm origin/main
cd /tmp/ea-deploy/crm && pnpm install --frozen-lockfile
pnpm exec everyapp deploy --gateway https://everyapp.team --account-id 23bc28f0b638fbfc1c7f838573c17ee3
pnpm exec everyapp secret unset TOKEN_ENCRYPTION_KEY --app crm --gateway https://everyapp.team
```

**5. OpenMail** (a new app, id `openmail`, at `openmail.everyapp.team`).

```sh
git -C ~/private-open-mail fetch origin
git -C ~/private-open-mail worktree add --detach /tmp/ea-deploy/openmail origin/everyapp
cd /tmp/ea-deploy/openmail && pnpm install --frozen-lockfile
pnpm exec everyapp deploy --gateway https://everyapp.team --account-id 23bc28f0b638fbfc1c7f838573c17ee3
```

**6. Check.**

```sh
cd /tmp/ea-deploy/pea && pnpm everyapp status --gateway https://everyapp.team
```

- Anything "Needs setup" names its command (`pnpm everyapp configure <app>`).
- Then, in each app, connect Google again:
  - OpenSEO: the member who picked each project's property reconnects first;
  - CRM: Connect Gmail and Calendar / Connect Outlook;
  - OpenMail: Connect Gmail.
- Live check (TODO.md): two apps on one Google client get tokens with different scopes. `pnpm everyapp provider connections --provider google-workspace --all --gateway https://everyapp.team` lists them.

**7. Later.** The old `agentic-inbox` app is unaffected (no OAuth). Delete it once OpenMail works: `pnpm everyapp delete agentic-inbox --gateway https://everyapp.team`. (Done 2026-11-03.)

**Rollback.** `pnpm everyapp db restore --gateway --account-id 23bc28f0b638fbfc1c7f838573c17ee3` (back to before migration 0025; the bookmark from step 2 is the same point), then `pnpm everyapp setup --allow-downgrade` from a checkout of `cc6735233`. The apps' previous versions stay in Cloudflare's version history.
