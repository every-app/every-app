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

### Simplify batch (2026-11-03; #945–#959)

- [ ] **Events design (#953): build it?** It brings three leans:
  - no inbox on the Gateway for incoming webhooks;
  - apps declare the events they emit in the manifest;
  - drop `app.ready`, `app.needs_setup` (with `apps.setup_state`), `tool.error` and `connection.used`.
- [ ] **OAuth clients: one store, but which?** Lean: the sealed D1 store, written from the browser, CLI or MCP. Drop the Worker-secret path. See the audit doc, "Queued: OAuth providers in one shape".
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

- [ ] **The remote MCP apps live check** (#938): add an OAuth server with DCR (Linear's), connect two members, call, refresh, disconnect. A live test, on a test Gateway.
- [ ] **ElevenLabs' hosted MCP needs CIMD.** It takes only OAuth, and its authorization server offers CIMD but no DCR. Build CIMD, and let an OAuth `mcp add` past the catalog's `elevenlabs` host claim?
- [ ] **Remote MCP apps on everyapp.team are added again after #938.** Migration 0031 drops `remote_mcp_credentials`; an old app reads "registered before provider credentials" until `mcp remove`, then `mcp add`.
- [ ] **The OAuth-simplify live check** (#942): two apps on one Google client get tokens with different scopes, each connection holding only its own app's scopes. A live test, run on a test Gateway.
- [ ] **The apps move to provider scope names** in `everyapp.config.ts` (OpenMail, OpenSEO, OpenCRM; CHANGELOG.md has the before and after) and redeploy; migration 0025 drops existing connections, so people connect again in each app. The rollout steps for everyapp.team are in #943.
- [ ] **Roll the simplify batch (#945–#959) out to everyapp.team.** Live steps, in this order:
  1. Confirm OpenSEO, OpenMail and CRM were last deployed with an rc.9+ CLI (#962 says rc.11). Otherwise deploy each once with it first: bucket adoption is gone, so a later deploy would stop with `RESOURCE_NAME_TAKEN`.
  2. `pnpm everyapp update --gateway https://everyapp.team` from main. It applies migrations 0026–0030: dollar caps, one AI default, the `everyone` flag, read/write tools and the Access evaluation key. Cap reads fail for a few seconds during the swap.
  3. `pnpm everyapp access on`, once. It swaps the email-list policy for the External Evaluation rule and bypasses `/access-evaluation/*`.
     - Check that an invitee gets in with no rerun.
     - Check that a stranger is refused at Access.
     - Check that `access.evaluated` shows in the Worker logs.
  4. `pnpm everyapp login --gateway https://everyapp.team`: admin commands now go through the Gateway's tools (or set `EVERYAPP_TOKEN`).
- [ ] **Publish rc.12 (`pnpm publish:rc 0.3.0-rc.12`), then re-pin the apps exactly to it.**
  - Analytics is on rc.1; OpenSEO-everyapp, Mission Control and RepoLens on rc.3; Workout and Talk on `^rc.10`.
  - App edits that ride the re-pin:
    - `risk: "destructive"` → `"write"` plus `destructive: true` in CRM, Analytics, OpenMail and Postiz.
    - `bearerRoutes` → `public` entries with `bearer: true` in the Birds hub and Talk/Open Notes, then `access on`.
    - Workout and Mission Control swap their copied skills for links.
