# TODO

Open questions and steps waiting on Ben, one line each where possible. A default someone
already took is not a question: it lives in the code and its pull request.
Delete a line once it is answered; git keeps the history. Everything this
file held before 2026-11-02 (finished work, defaults taken, follow-ups, the
list of live checks not yet run) is in its history at `673bed8c8`. Security
gaps are in [docs/security.md](docs/security.md), "Known gaps".

## Questions for Ben

### Platform

- [ ] **Close a removed member's WebSockets at once?** Today a socket lasts up to 15 minutes after removal, deactivation or losing the app. Closing it at once needs a Durable Object per organization holding the relays. Worth the Durable Object, or is 15 minutes fine?
- [ ] **Hosted offboarding.** Should removing a member also end their sessions in that organization, and should Deactivate offer "Clear app access" (default: keep)?
- [ ] **Where IdP groups come from**, for mapping SSO or Access groups to Gateway groups: the OIDC `groups` scope on the sign-in path, the outer-ring JWT's `custom` claim, or a `/cdn-cgi/access/get-identity` call at sign-in?
- [ ] **Take Better Auth off the app-host path?** A warm app request waits on three D1 reads in a row (session, user, access row). A direct session reader would cut that, at the cost of a change to identity code.
- [ ] **Granola for agents: which first?** (a) A curated MCP app over the API key, like DataForSEO, or (b) `mcp add --auth oauth` (built in #938), which brings Granola's own MCP tools and works on its Basic plan.
- [ ] **Granola personal keys.** A personal key reads one person's notes for every member who can open the app. Say on the provider page that a team should use a workspace key with Public notes only?

### Apps

- [ ] **RepoLens badges** are public even for private repositories. Keep that, or answer 404 for private ones?
- [ ] **OpenSEO's `[research-spend]` line.** Keep it beside the Gateway's usage counters (it knows projects; the Gateway sees calls), or retire it now that the Gateway records DataForSEO cost and model tokens per organization?

### Docs and site

- [ ] **"Docs for your coding agent"** in the user docs' sidebar is an external entry, so an on-site page opens in a new tab with an external icon. Intended?
- [ ] **Does `docs/design/2026-10-cold-read.md` go into the public copy?** Designs travel by default; it is a candid outside read of the dogfood Gateway.
- [ ] **The README's Discord invite** is the OpenSEO server's. Keep it, or make an Every App server?

### Repository

- [ ] **Fold the Built CLI job into `pr-checks.yml`?** One fewer workflow to read, against the unit tests waiting on an install.

### Desktop app (`apps/desktop`)

- [ ] **One sign-in per feature?** A native token opens one app, so a second feature (dictation, notes) on another backend means a second grant: a sign-in per feature, or a Gateway-level grant that covers the workspace's apps?
- [ ] **OpenScribe's install command.** Onboarding shows `everyapp install https://github.com/every-app/private-open-scribe` (`apps/desktop/src/shared/setup.ts`), but that repository is private and `install` needs a published release. Make it public with a release, or give the real command.

### Simplify batch (2026-11-03; #945–#959)

- [ ] **Events design (#953): build it?** It brings three leans:
  - no inbox on the Gateway for incoming webhooks;
  - apps declare the events they emit in the manifest;
  - drop `app.ready`, `app.needs_setup` (with `apps.setup_state`), `tool.error` and `connection.used`.
- [ ] **OAuth clients: one store, but which?** Lean: the sealed D1 store, written from the browser, CLI or MCP. Drop the Worker-secret path. #974 made every OAuth provider a preset and kept both stores. See the audit doc, "OAuth providers in one shape".
- [ ] **Public routes and Access (#959).** A CLI deploy that changes an app's public routes runs `access on`'s recipe by itself; a browser install only logs `access.rerun_needed`. Fine, or a fixed public path prefix? A prefix breaks embedded snippets like Analytics' `/collect`.
- [ ] **Admins open every app (#947).** Owners and admins now open every app through their role, so an admin can't be left out of one app. Fine?
- [ ] **`ai.routes` on a hosted Gateway (#945).** The manifest is the whole grant now. On a shared OpenAI key, an app naming OpenAI routes could reach other organizations' files and batches. Lean: refuse `ai.routes` when the Gateway is hosted.
- [ ] **CLI admin acts as you (#954).**
  - No operator root from the terminal: `--org` is gone, and an admin can't change an owner.
  - `workspace invite-link` is gone; copy the link from Admin → Users.
  - Should `workspace reset-link` move to the unused `recovery` kind of the owner setup link?
- [ ] **Blog line "An agent can't delete anything"** (`landing-page/content/blogs/open-source-backlink-outreach.md`). It's false since #952: tools are read or write. Edit the dated post, or leave it?
- [ ] **Engineering follow-ups now live nowhere but TODO.md's history** (`673bed8c8`). Track open work as GitHub issues?

## Waiting on Ben

- [ ] **Simpler releases** ([docs/design/2026-11-simplify-releases.md](docs/design/2026-11-simplify-releases.md), "Waiting on Ben"): the first `pnpm release patch` (→ 0.3.0), then drop the `next` dist-tag.
- [ ] **Check the desktop app on a Mac** (it was moved from private-talk and renamed on Linux): `apps/desktop/mac/scripts/test.sh` or the Desktop workflow's Swift job, `pnpm -C apps/desktop package:local`, then: Keychain Access shows "com.everyapp.desktop.dev Safe Storage" (with `EVERYAPP_DESKTOP_DEV_KEYCHAIN=1`), data is in `~/Library/Application Support/com.everyapp.desktop.dev`, the menus say "Every App Dev", `everyapp-dev://scribe/record` opens it.
- [ ] **Scribe's side of the desktop rename** (every-app/private-open-scribe): the web app opens `talk://record…`, and must open `everyapp://scribe/record…`.
- [ ] **The remote MCP apps live check** (#938): add an OAuth server with DCR (Linear's), connect two members, call, refresh, disconnect. A live test, on a test Gateway.
- [ ] **The ElevenLabs live check** (#969): after `update` (which adds the `/oauth-clients/*` Access bypass), `mcp add https://api.elevenlabs.io/v1/mcp`, connect, call one tool. A live test.
- [ ] **Remote MCP apps on everyapp.team are added again after #938.** Migration 0031 drops `remote_mcp_credentials`; an old app reads "registered before provider credentials" until `mcp remove`, then `mcp add`.
- [ ] **The OAuth presets live check** (#974), on a test Gateway with a Google client in Worker secrets and one pasted in Admin:
  - `update` (migration 0032 registers and binds the Google, Microsoft 365 and Slack rows); existing connections still work.
  - Disconnect an idle Google connection; the grant is gone at myaccount.google.com.
- [ ] **The one-connection live check** (`docs/design/2026-11-oauth-one-connection.md`; replaces #942's): two apps on one Google client. Connecting in the first asks Google for both apps' scopes. The second shows the Allow page and never leaves the Gateway. An app that isn't allowed gets `integration_not_connected`. Disconnect stops both. `update` on a Gateway with per-app connections keeps one per person (migration 0034). A live test, run on a test Gateway.
- [ ] **The apps move to provider scope names** in `everyapp.config.ts` (OpenMail, OpenSEO, OpenCRM; CHANGELOG.md has the before and after) and redeploy; migration 0025 drops existing connections, so people connect again, once per provider. The rollout steps for everyapp.team are in #943.
- [ ] **Update everyapp.team after 0.3.0 is published** (migration 0033 only): `pnpm everyapp update --gateway https://everyapp.team --release https://github.com/every-app/every-app`, then `pnpm everyapp login --gateway https://everyapp.team` only if admin commands say signed out.
- [ ] **Re-pin the apps exactly to 0.3.0.**
  - Draft re-pin PRs, to merge once 0.3.0 is on npm: private-open-analytics#44, private-open-crm#25, private-open-mail#24, private-open-seo#1264, private-repolens#7, private-mission-control-everyapp#5, private-workout#1, private-open-scribe#66, private-birds#37.
  - The edits that ride the re-pin are done (`risk` in CRM, Analytics and OpenMail; `bearer` in Birds and Talk), or in their PRs (Workout, Mission Control).
  - Knowledge Base still needs its re-pin; its source repository hasn't been found yet.
