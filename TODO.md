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
- [ ] **Granola for agents: which first?** (a) A curated MCP app over the API key, like DataForSEO, or (b) OAuth for `mcp add --auth oauth`, which brings Granola's own MCP tools and works on its Basic plan but touches the perimeter and identity.
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

## Waiting on Ben

- [ ] **The OAuth-simplify live check** (#942): two apps on one Google client get tokens with different scopes, each connection holding only its own app's scopes. A live test, run on a test Gateway.
- [ ] **The apps move to provider scope names** in `everyapp.config.ts` (OpenMail, OpenSEO, OpenCRM; CHANGELOG.md has the before and after) and redeploy; migration 0025 drops existing connections, so people connect again in each app. The rollout steps for everyapp.team are in #943.
