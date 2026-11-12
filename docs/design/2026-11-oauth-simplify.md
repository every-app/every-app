# OAuth providers, simplified

Date: 2026-11-02. Status: **shipped** (#942). On 2026-11-10, [2026-11-oauth-one-connection.md](2026-11-oauth-one-connection.md) replaced rule 2 (one connection per person per app) and what this document says about per-app scopes. The rest stands.

## The rule

1. An app's `everyapp.config.ts` names the provider and the provider's own scopes it needs.
2. A person connects **in that app**. The provider's consent screen shows exactly those scopes, and the connection belongs to that person and that app.
3. The app may use the connection however it likes, foreground or background, for as long as it exists.
4. The Gateway refuses any token that carries more scopes than the config lists, even if the Google client could grant more.
5. Nothing in the code is specific to Google, Gmail or any other provider. What differs between providers is data in the provider's spec.

## What we delete

| Delete | What it is | Why it goes |
| --- | --- | --- |
| **Shared connections** (one per person per provider, used by every app) | One connect asked for the union of every app's scopes | The root of everything below. It's replaced by one connection per person per app |
| **Scope sets** (`gmail.read`, `search-console.read`, …) with their `routes`, `posts`/`puts`/`patches`/`deletes`, the anchored-regex rules (#923, #929), `deniedSegments`, and OAuth `access: read/write` | Named bundles, plus per-URL, per-method allowlists, so app A couldn't use the scopes app B asked for on a shared token | No shared token, so nothing to narrow. Apps name provider scopes directly |
| **Operator overlays**: `everyapp provider scope-set add/remove`, its MCP tools, the scope-set table, `scopeSetOverlay` | The operator writing missing sets as JSON | Only existed because the catalog's sets were incomplete |
| **Dev overlay files**: `.everyapp/scope-sets/`, `EVERYAPP_DEV_SCOPE_SETS` (#921) | Dev copies of the overlays | No overlays |
| **Background grants** (#898): the second Allow page, `provider_background_grants` (migration 0024), the `background` manifest field, `connectUrl({ background })`, `connection.background`, `provider.background_*` events | A separate per-person "allow this app while I'm away" click | Connecting already means the app may use it |
| **Idle lapse + keep-alive** (#924): 90-day sweep, the perimeter's and tool calls' `last_seen_at` touch | Background permission ended after 90 days in which the person didn't open the app | Goes with background grants |
| **`optionalScopes`** (#902), `?optional=` | Asking for some scopes later | Every scope in the config is asked for at connect |
| **Organization connections**: "Connect for the organization", `account: "organization"` | An admin connects one shared account (say support@) for work no person started | No app uses it today. Bring it back if one does |
| **Provider-specific code**: the `google`/`microsoft`/`slack` scope dialects, Slack's two-token parser, Google's hand-written catalog entry and its `google-proof` test | Each provider's quirks in TypeScript | Google, Microsoft and Slack become JSON specs like GitHub. Their differences are data: authorize and token URLs, API hosts, scope separator, scope prefix (Google's `https://www.googleapis.com/auth/`), extra authorize params (Google's `access_type=offline`), identity URL |
| **App-driven token flow** (the app runs the OAuth dance and holds tokens; the Gateway only completes the token endpoint) | The pre-Gateway-flow path, with its own scope checks | One flow is enough. **CRM still uses it** (Google and Microsoft mail), so CRM moves to `connectUrl` + `integrationFetch` first. The social-network entries (Postiz, not launching) go with it |

Error codes that go: `integration_scope_not_allowed`, `integration_scope_not_granted`, `integration_scopes_undeclared`, `integration_method_not_allowed` (OAuth).

## What stays

- Providers: the client id and secret, added once per provider (`everyapp provider add`, or Manage workspace → Providers).
- `/connect/<id>?app=<app>`, then the callback, then tokens stored encrypted, refreshed when due, and never given to the app.
- The proxy: `integrationFetch()` puts the person's token on calls to the provider's **hosts** only.
- **The mint check:** if the provider's answer says the token holds scopes beyond the config, it's refused and dropped. This is the rule "the Gateway blocks scopes the app didn't declare". A provider that answers with no `scope` is taken as granted exactly as asked.
- Connected accounts lists each connection with its app, with Disconnect. Admins can disconnect anyone.
- Lifecycle: removing a member deletes their connections. A member losing access to an app deletes their connection for that app. Deleting an app deletes its connections.
- In the background, the app names whose connection it means: `for: { userId }`. That only addresses a connection; it isn't a permission.
- #926 (dev reads `<PREFIX>_ACCESS_TOKEN` from `.dev.vars`).
- The unrelated parts of #929.
- Events: `provider.connected`, `provider.disconnected`, a daily `connection.used`, and `integration.proxy.call`.

## OpenMail, after

```ts
"google-workspace": {
  scopes: ["gmail.modify", "gmail.send"],
  why: "Mirrors your Gmail, writes reply drafts as mail arrives, and sends when you press Send.",
},
```

- **Connect:** someone opens OpenMail and selects **Connect Gmail**. Google shows those two scopes, and they're back in OpenMail. That's the only step.
- **Sync:** the Durable Object alarm syncs every 2 minutes and writes AI drafts whether or not anyone has OpenMail open. Each call is `integrationFetch(…, { for: { userId } })` on that person's own connection.
- **Privacy:** the Gateway only ever uses Ben's connection for calls OpenMail makes for Ben. Another member's call never gets Ben's token. Who can see a mailbox *inside* OpenMail is OpenMail's own logic, which already keeps each mailbox to its owner.
- **Blocked:** a token with any scope beyond `gmail.modify` and `gmail.send`, and any call to a host that isn't the provider's.
- **Stop:** disconnect in OpenMail or in Connected accounts, or be removed from the workspace.
- **Deleted from OpenMail #19:**
  - `docs/gmail/*.json`;
  - `.everyapp/scope-sets/`;
  - the `background` block;
  - `gmail.read` and `identity` (`gmail.modify` already includes reading; the account name comes from the provider spec's identity URL);
  - the background-consent handling.
- **Personal @gmail.com accounts:** see `/docs/google-personal-accounts`.

## What we give up

- **No Gateway narrowing inside a scope.** Google's `gmail.modify` includes sending, so the Gateway can't stop an app that holds it from sending. The boundary is what the person approved on Google's screen.
- **No separate "while I'm away" consent.** A compromised app can use the connections people made in it, any time.
- **An occasional reconnect.** Some providers (Microsoft, Slack) can hand back every scope a person ever approved on the client. If two apps share that client with different scopes, the wider token is refused, and the fix is a separate client per app. Google doesn't do this. No special code for it.

## Rollout

1. **CRM:** move mail to `connectUrl` + `integrationFetch` (one CRM PR).
2. **Gateway + SDK + CLI:** one PR, mostly deletions. Existing connections are dropped, so people reconnect in each app. It adds `CHANGELOG.md` (none exists yet), with a breaking-changes entry: what changed, and for each app what to edit in `everyapp.config.ts` (provider scope names, no `background` or `optionalScopes`). Run `pnpm security-review` before merging.
3. **Apps:** OpenMail, CRM and OpenSEO change their manifests to provider scope names (one small PR each).
4. **Live check (your call):** two apps on one Google client get tokens with different scopes.

## Decisions taken (say if you disagree)

- **Delete organization connections**, because nothing uses them.
- **Delete the app-driven flow**, after CRM moves.
- **Slack uses the top-level (bot) token only.**
