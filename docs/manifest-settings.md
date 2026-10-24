# App settings: what an app needs, and whether it is set

Status: decided 2026-10-23 and built 2026-10-24 as a stack on #383 (the
model) with one pull request per surface, the `t3/launch-secrets-*`
branches: the CLI, the gateway's app lists and registry, the gate and
`/mcp`, and these documents; each live app gets a manifest pull request in
its own repository. This is the reference the public docs page is written
from. [docs/capabilities.md](capabilities.md) says what each capability is
and how an app calls it; this document says how an app declares what it
needs, how the gateway and the CLI tell whether it is set, and what happens
while it isn't. TODO.md's "Secrets model (2026-10-24)" section holds every
default the builders chose.

## 1. A setting

An app's `everyapp.config.ts` names what the app needs before it works
fully: the AI providers it calls, the capabilities it uses through the
gateway, and the secrets of its own. Each is a **setting**: one thing an
operator sets once, by name, with `pnpm everyapp secret set NAME`. Four
kinds, two holders:

| Kind         | Declared as                                        | Held on              | "Set" means                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------ | -------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`   | `providers: ["openrouter"]`                        | the Gateway Worker   | its key is set: `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, or for Workers AI `WORKERS_AI_API_TOKEN` (`CLOUDFLARE_ACCOUNT_ID` is the install's own, set by `everyapp setup`, and never asked for)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `capability` | `capabilities: { dataforseo: { access: "read" } }` | the Gateway Worker   | its required Gateway settings are set: an API-key capability's key; an OAuth client's id and secret, plus its host setting when the client has no default instance (Mastodon's `MASTODON_URL` is only read when set, since `mastodon.social` is the default); a service's `settings` (`members` has none, so it is always set). A capability's optional settings are read when set and never required. The gateway may answer by the capability's own rule instead of its names: email is configured once a sender parses and a provider is selectable (`isEmailConfigured()`). The model names `EMAIL_FROM` for it, and the sender needs a display name too, from `EMAIL_FROM_NAME` or `EMAIL_FROM="Name <address>"`; a bare address is not configured |
| `secret`     | `secrets: ["MAIN_SECRET"]`                         | the app's own Worker | the name is set on the app's Worker                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ai-routes`  | `ai: { routes: ["/v1/files"] }`                    | the Gateway Worker   | `AI_PROXY_EXTRA_ROUTES` is set. Always required; it has no entry of its own to annotate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

A Gateway setting is set when its value is non-empty in the Gateway
Worker's env (the CLI reads the same names with
`cf workers secrets list --worker every-app-gateway`). An app's own secret
is set when its name is on the app's Worker, as the CLI last recorded it
(§4, "How app secret names are recorded"). No surface reads a value, only
names, and a closed app's 503 carries no names: what the gateway holds is
the organization's to see, not a visitor's.

The model is one SDK module, `packages/sdk/src/internal/appSettings.ts`:
`appSettings(manifest)` lists the settings in manifest order (providers,
capabilities, the AI routes, secrets); `evaluateAppSettings` checks them
against whoever can say what is set; `setupCommand` writes the one command
that opens the app; `appSetupOf` sums it all up as the JSON every surface
returns (§5). A provider or capability the gateway doesn't offer
contributes no setting: `everyapp deploy` refuses an unknown capability,
and the AI proxy refuses a call to an unknown provider
(`ai_provider_not_supported`).

## 2. Needs

Every setting has a **need**, which says what happens while it is unset:

- **`required`**, the default. The app does not open until it is set: the
  gateway shows it as "Needs setup", answers its routes with a redirect or
  a 503, and leaves its tools out of `/mcp` (§4).
- **`optional`**. The app opens; the feature that uses the setting says
  what is missing, where it is used (§6).
- **A member of an any-of group**, `anyOf: "AI model"`. The group is met
  once any member is set; more set is fine. While no member is set, every
  member blocks, and the setup command names the first one with the others
  as alternatives.

The rule for authors:

- Required means the app is useless without it. A setting only one feature
  needs is optional, and the feature says what is missing where it is
  used. Public routes close with the app, so weigh `required` against the
  public surface: a tracker whose `MAIN_SECRET` is required goes dark at
  `/collect` along with its dashboards.
- `anyOf` is only for an app that picks among the _set_ members at run
  time. The gateway refuses a call to a provider whose key isn't set,
  whichever others are (`ai_provider_not_configured`), so an app that
  chooses its provider at build time (an `AI_PROVIDER` var) declares that
  one required and the other optional. A group's member is optional by
  itself; the validator refuses an entry that says both. A group may span
  kinds: a Gateway provider and a key of the app's own can be the two
  members of "AI model".

Every setting may also carry:

- `why`: why the app needs it, for whoever sets it, 1 to 200 characters.
  The "Needs setup" dialog, `everyapp status`'s `APP_NEEDS_SETUP` detail
  and an agent reading `setup` all show it.
- `docs`: where the key or client comes from, an https URL, shown as "Get
  it at <docs>". Providers and capabilities get a default from the SDK
  registries (`DEV_AI_PROVIDERS[id].docs`, an API-key capability's `docs`,
  an OAuth client's `console`), which the manifest may override:

| Setting                                                | Default `docs`                                                                                                                                                                                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openai`                                               | https://platform.openai.com/api-keys                                                                                                                                                                                                           |
| `openrouter`                                           | https://openrouter.ai/settings/keys                                                                                                                                                                                                            |
| `workers-ai`                                           | https://dash.cloudflare.com/profile/api-tokens                                                                                                                                                                                                 |
| `dataforseo`                                           | https://app.dataforseo.com/api-access                                                                                                                                                                                                          |
| `context`                                              | https://context.dev/                                                                                                                                                                                                                           |
| an OAuth client                                        | its developer console, the "Developer console" column of the [OAuth clients table](capabilities.md#oauth-clients); for a client with no fixed host, the path on the default instance (Mastodon: https://mastodon.social/settings/applications) |
| `email`, `members`, the AI routes, an app's own secret | none, unless the manifest gives one                                                                                                                                                                                                            |

A setting may also carry `setup`: the everyapp skill's guide to setting it
up end to end, relative to the skill (`setup/dataforseo.md`). The guides
are the skill's own, under `packages/cli/skills/everyapp/setup/` in the
checkout and `.claude/skills/everyapp/setup/` in every app, with an index
in `setup/README.md`; an agent reads the guide before it asks anyone for
a value. A provider's or a capability's guide comes from the SDK
registries (`DEV_AI_PROVIDERS[id].setup`, a capability's `setup`: openai,
openrouter, workers-ai, dataforseo, context, email, google-workspace,
microsoft-365, slack and youtube, which shares `setup/google.md`; the AI
routes share `setup/openai.md`; `members` and the other 14 social clients
have none), and the manifest can't change it.
An app's own secret may name its own guide with
`setup: "setup/<name>.md"` on its entry; without one it has none.

## 3. The manifest

```ts
providers: Array<string | { id: string; why?: string; docs?: string; optional?: boolean; anyOf?: string }>
capabilities: { [id]: { access: "read" | "write"; why?: string; docs?: string; optional?: boolean; anyOf?: string } }
secrets: Array<string | { name: string; why?: string; docs?: string; optional?: boolean; anyOf?: string; setup?: string }>
```

A bare string is a required entry with no `why` and the default `docs`.
The two forms mix in one list. The AI routes take no entry: `ai.routes`
with anything in it is one required setting. `setup` is a secret entry's
only; a provider's or a capability's guide is the registry's (§2).

**What the strict validator refuses.** The CLI reads an
`everyapp.config.ts` with the strict schema; the gateway registers a stored
manifest with the lenient one, which accepts both forms and passes unknown
entry fields through. The strict rules, with the message each gives (every
one begins `Invalid everyapp.config:`; the paths are zod's, the index in a
list or the id under `capabilities`):

| Rule                                                                                | Message                                                                                                                                                                 |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `optional` and `anyOf` on one entry                                                 | `providers: workers-ai is both optional and in the any-of group "AI model"; a group's member is optional by itself, so drop one of them.`                               |
| an any-of group with one member, counted across providers, capabilities and secrets | `the any-of group "AI model" has one member (providers: openrouter); an any-of group needs two or more. Drop anyOf, or mark it optional.`                               |
| a provider listed twice, in either form                                             | `providers.1: duplicate provider`                                                                                                                                       |
| a secret listed twice, in either form                                               | `secrets.1: duplicate secret GITHUB_TOKEN`                                                                                                                              |
| `docs` that isn't https                                                             | `secrets.0.docs: must be an https URL` (a value that isn't a URL at all gets `Invalid url` as well)                                                                     |
| `why` empty, or over 200 characters                                                 | `capabilities.context.why: String must contain at most 200 character(s)`                                                                                                |
| `anyOf` empty, or over 40 characters                                                | `secrets.0.anyOf: String must contain at most 40 character(s)`                                                                                                          |
| a field the entry doesn't take (`required: true`, say)                              | `secrets.0: Unrecognized key(s) in object: 'required'`                                                                                                                  |
| `setup` on a provider or a capability entry                                         | `providers.0: Unrecognized key(s) in object: 'setup'`; `capabilities.email: Unrecognized key(s) in object: 'setup'` (their guides are the registry's)                   |
| a secret's `setup` that isn't a guide in the skill                                  | `secrets.0.setup: must be a guide in the everyapp skill, such as "setup/main-secret.md"` (`setup/<lowercase name>.md`)                                                  |
| a secret named like a Gateway setting                                               | ``secrets.0: OPENAI_API_KEY is a Gateway setting, which `everyapp secret set OPENAI_API_KEY` sets on the Gateway for every app; list `openai` under providers instead`` |
| a secret named like one everyapp sets itself                                        | `secrets.0: GATEWAY_URL is set by everyapp itself (GATEWAY_URL, CF_VERSION_METADATA and the EVERYAPP_*, EVERY_APP_* and APP__* names)`                                  |
| a secret named like one of the app's bindings                                       | `secrets: DB is one of the app's bindings; pick another name for the secret`                                                                                            |
| a capability the gateway doesn't offer, or an access level it doesn't               | `capabilities.foo: unknown capability (the gateway offers: dataforseo, context, email, members, …)`; `capabilities.dataforseo.access: DataForSEO offers read access`    |

The name rules are the ones `secrets` had before needs existed; they apply
to an entry's `name` as to a bare name.

### Example: an OpenSEO-like app

Three settings, all the Gateway's. Context.dev only renders JavaScript in
site audits, so it is optional; the other two are what the app is for.

```ts
export default {
  id: "openseo",
  name: "OpenSEO",
  providers: [
    { id: "openrouter", why: "Writes audit summaries and keyword briefs." },
  ],
  capabilities: {
    dataforseo: {
      access: "read",
      why: "Keyword, SERP and backlink data for every report.",
    },
    context: {
      access: "read",
      optional: true,
      why: "Renders JavaScript pages in site audits; audits run without it.",
    },
  },
} as const;
```

With `OPENROUTER_API_KEY` set and the other two unset, the app is closed
for `DATAFORSEO_API_KEY` alone, and the one command is
`pnpm everyapp secret set DATAFORSEO_API_KEY`. `CONTEXT_API_KEY` stays "not
set (optional)" in `everyapp status`, and the audit settings say that JS
rendering isn't set up on this gateway (§6).

### Example: an analytics-like app, an optional email and a required secret of its own

```ts
export default {
  id: "analytics",
  name: "OpenAnalytics",
  public: [{ path: "/collect", methods: ["POST"] }],
  capabilities: {
    members: { access: "read", why: "Whom scheduled reports go to." },
    email: {
      access: "write",
      optional: true,
      why: "Emails the weekly report; without it the report is only in the app.",
    },
  },
  secrets: [
    {
      name: "MAIN_SECRET",
      why: "Signs the tracker's collect requests; nothing is recorded without it.",
      docs: "https://docs.example.com/analytics/main-secret",
      setup: "setup/main-secret.md",
    },
  ],
} as const;
```

`members` has nothing to set and is always set. `EMAIL_FROM` unset leaves
the app open with the weekly email off. `MAIN_SECRET` is the app's own, so
the one command names the app and runs from anywhere:
`pnpm everyapp secret set MAIN_SECRET --app analytics`. While it is unset,
`/collect` answers 503 with the rest of the app (it is public, but public
routes close with the app); the author accepted that because the tracker
records nothing without the secret anyway. `MAIN_SECRET`'s `setup` names a
guide the app adds beside the skill's own,
`.claude/skills/everyapp/setup/main-secret.md`; email's is the registry's
`setup/email.md`. §5 shows this app's `setup`.

### Example: one of several AI providers

An app that uses whichever of its providers is set (today by trying one and
falling back on `ai_provider_not_configured`; a status route is left for
later, §8) declares a group. Email is still required.

```ts
export default {
  id: "writer",
  name: "Writer",
  providers: [
    { id: "openrouter", anyOf: "AI model", why: "Drafts and rewrites." },
    {
      id: "workers-ai",
      anyOf: "AI model",
      why: "Drafts and rewrites, in the gateway's own Cloudflare account.",
    },
  ],
  capabilities: {
    email: { access: "write", why: "Sends finished drafts." },
  },
} as const;
```

With nothing set, every member of "AI model" blocks and the command is
`pnpm everyapp secret set EMAIL_FROM OPENROUTER_API_KEY`, with the note
"WORKERS_AI_API_TOKEN instead of OPENROUTER_API_KEY is fine too: one AI
model is enough". With `WORKERS_AI_API_TOKEN` set the group is met,
`OPENROUTER_API_KEY` reads "not set (one of: AI model)", and only
`EMAIL_FROM` is left. The validator refuses this manifest with one member
removed ("an any-of group needs two or more"), and refuses `optional: true`
on either member.

## 4. Where it shows

### The gateway: home, the app library, Admin → Apps

Every app list the gateway serves (`getMyApps`, Admin → Apps' `getApps`)
carries `setup: AppSetup | null` per app (§5): null when the manifest
declares nothing to set, or the app is on the dispatch tier, whose
providers and capabilities ride the platform's settings, which the
platform checks at deploy rather than at run time. A provider app
(`pnpm everyapp provider on dataforseo`: an `apps` row of tier `provider`
with no Worker) lists its capability in its generated manifest, so it reads
"Needs setup" until `DATAFORSEO_API_KEY` is set
([docs/capabilities.md](capabilities.md#provider-apps)). An app whose
`setup.ready` is false shows a "Needs setup" badge (a warning, placed
after the active check, so an active, bound app that isn't ready shows it)
and does not open. The card and the Admin → Apps badge open a dialog: each
unmet setting with its `why` and "Get it at <docs>", then the one command
with a copy button. A non-admin sees the same names with "Ask an admin to
run:". A shared app seen from another organization carries no command
(`setup.command` is null; the platform operator fixes it). The dialog ends
with "Already set it another way? `pnpm everyapp status` re-reads the
Worker." `?setup=<appId>` on the launcher opens the dialog, which is where
a closed app sends a browser.

### What a closed app answers

The perimeter asks the gateway `needsSetup(app, { publicRoute })` after
the status and activation checks, for every path, public routes included.
The gateway evaluates the app's stored manifest against its own env and
the app's recorded secret names, cached per row, version and names; a
change reaches every isolate within the 30 seconds the app's row is
cached, and a redeploy or a `secret set` makes a new version at once. Not
ready: a private HTML GET navigation is sent (302) to
`${GATEWAY_URL}/?setup=<appId>`; anything else (a public route, an API
call, a non-GET) answers `503 { "error": "app_needs_setup", "app": "<id>" }`
with no `retry-after`. Setting names are never in the body: what the
gateway holds is the operator's to know, not a visitor's.

### `/mcp`

The gateway's `/mcp` leaves out the tools of an app that needs setup and
says so in the server instructions. `everyapp_list_apps` lists such an app
with `available: false` and `reason: "needs setup: an admin runs <command>"`
(plain `"needs setup"` when the command isn't the caller's to run), so a
client holding a listen stream can learn why a tool is gone and ask. The
app host's own
`/mcp` is behind the perimeter gate above.

### `everyapp status`

For every app that declares any setting, a SETTINGS table (APP, SETTING,
WHERE, STATUS); the APP table's cell says `! needs setup`; and one
`APP_NEEDS_SETUP` problem per app (a warning, not a failure), with `Run:`
the one command, its note when an any-of group has alternatives, and a
detail line per unmet setting, "NAME: why". `status` reads each deployed
app's Worker's secret names and records them (below); `pending` apps and
apps whose Worker is missing are skipped. When `cf workers secrets list`
fails, one `SETTINGS_UNKNOWN` warning and the rows read as unknown, which
never blocks. `--json` carries `data.apps[].setup` (§5).

The STATUS column, on every surface the CLI renders settings:

| STATUS                       | Meaning                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `✓ set` (green)              | every name the setting needs is set                                                     |
| `! not set` (yellow)         | required and unset, or every member of an any-of group is unset: the app is closed      |
| `not set (optional)` (dim)   | optional and unset: the app is open, the feature says so                                |
| `not set (one of: AI model)` | a group member that is unset while another member is set                                |
| `! not recorded` (yellow)    | an app secret whose Worker's names were never recorded: run `pnpm everyapp status` once (on a Gateway from before migration 0004 the column itself is missing until `pnpm everyapp update`; status and secret list read the names as not recorded meanwhile) |

### `everyapp secret list [<app>]`

Takes an optional app id: by default the app in the current directory;
from elsewhere with no id, the Gateway's table and then every app's
settings. The same renderer and vocabulary as `status`. `--json` carries
`data.app.setup` (the `AppSetup` of §5, what the setup skills read) and
`data.app.settings`, and keeps `next` as the one command.

### `everyapp secret set|unset NAME... --app <id>`

`--app` reads the app's manifest from its registry row, so the command runs
from anywhere: a release deploy has no checkout, and the setup command the
gateway shows must work wherever it is pasted. The bare form in the app's
directory stays. Names route by name: a Gateway setting goes to the
Gateway, anything else to the app, and one call may mix them. Values come
from a hidden prompt, stdin or `--from-env VAR`; a plain setting's value
(`EMAIL_FROM`, a switch such as `EMAIL_PASSWORD_SIGN_IN`) is checked first
and refused with `SETTING_VALUE_INVALID` (#483); the change is one new
version of the live Worker, never a deploy. A name the manifest doesn't list is
refused (`SECRET_NOT_DECLARED`), and the fix line renders the entry to add
in the manifest's own form.

### `everyapp deploy`

After the upload, `deploy` lists the Worker's secrets and records them with
the deploy (below). When the app then needs setup, it ends with an
`APP_NEEDS_SETUP` warning ("crm won't open until CONTEXT_API_KEY is set")
and one `next` entry with the command ("crm opens once these are set").
`everyapp dev` enforces nothing: in dev the app reads its own `.dev.vars`.

### How app secret names are recorded

The gateway can't list an app Worker's secrets itself, so the CLI records
them: `apps.secret_names` (TEXT, a JSON `string[]`, null when never
recorded) holds the names on the app's own Worker, with everyapp's own
(`GATEWAY_URL`, `EVERY_APP_ORG_ID` and the rest it sets at deploy) left
out. Written by `deploy` (listed after the upload, in the same registry
update as the deploy itself, under the app's lease), `secret
set|unset` (after the app's Workers are patched) and `status` (every
deployed app, each run). Read by the gateway with the rest of the app's
row. Null never blocks and reads `! not recorded`: a change made outside
the CLI (the dashboard, `cf workers secrets` by hand) or a row from before
the column heals on the next `pnpm everyapp status`.

## 5. `AppSetup`, as agents read it

One shape on every surface: `setup` on the gateway's app lists,
`data.apps[].setup` in `everyapp status --json`, and `data.app.setup` in
`everyapp secret list --json`.

```ts
interface AppSetup {
  ready: boolean; // no required setting unset, every any-of group met
  settings: AppSetupSetting[]; // every setting, in manifest order
  unmet: AppSetupSetting[]; // the ones keeping the app closed
  groups: Array<{ group: string; met: boolean; members: string[] }>;
  command: { command: string; note?: string } | null; // null: ready, or not yours to run
}

interface AppSetupSetting {
  kind: "provider" | "capability" | "secret" | "ai-routes";
  id: string; // provider id, capability id, secret name, or "ai-routes"
  label: string; // "OpenRouter", "DataForSEO", "MAIN_SECRET", "AI proxy routes"
  holder: "gateway" | "app";
  names: string[]; // every name that must be set for the setting to count as set
  need:
    | { kind: "required" }
    | { kind: "optional" }
    | { kind: "anyOf"; group: string };
  why?: string;
  docs?: string;
  setup?: string; // the everyapp skill's guide to it, "setup/email.md": the registry's for a Gateway setting, the entry's for an app secret
  set: boolean | null; // null: not known (app names never recorded); never blocks
  blocking: boolean; // required and unset, or in an any-of group none of whose members is set
}
```

The analytics example of §3, on a gateway with no `EMAIL_FROM`, after the
app's names were recorded with none set:

```json
{
  "ready": false,
  "settings": [
    {
      "kind": "capability",
      "id": "members",
      "label": "Members",
      "holder": "gateway",
      "names": [],
      "need": { "kind": "required" },
      "why": "Whom scheduled reports go to.",
      "set": true,
      "blocking": false
    },
    {
      "kind": "capability",
      "id": "email",
      "label": "Email",
      "holder": "gateway",
      "names": ["EMAIL_FROM"],
      "need": { "kind": "optional" },
      "why": "Emails the weekly report; without it the report is only in the app.",
      "setup": "setup/email.md",
      "set": false,
      "blocking": false
    },
    {
      "kind": "secret",
      "id": "MAIN_SECRET",
      "label": "MAIN_SECRET",
      "holder": "app",
      "names": ["MAIN_SECRET"],
      "need": { "kind": "required" },
      "why": "Signs the tracker's collect requests; nothing is recorded without it.",
      "docs": "https://docs.example.com/analytics/main-secret",
      "setup": "setup/main-secret.md",
      "set": false,
      "blocking": true
    }
  ],
  "unmet": [
    {
      "kind": "secret",
      "id": "MAIN_SECRET",
      "label": "MAIN_SECRET",
      "holder": "app",
      "names": ["MAIN_SECRET"],
      "need": { "kind": "required" },
      "why": "Signs the tracker's collect requests; nothing is recorded without it.",
      "docs": "https://docs.example.com/analytics/main-secret",
      "setup": "setup/main-secret.md",
      "set": false,
      "blocking": true
    }
  ],
  "groups": [],
  "command": {
    "command": "pnpm everyapp secret set MAIN_SECRET --app analytics"
  }
}
```

How an agent uses it (the everyapp skill's rule): run
`pnpm everyapp status --json` and read `data.apps[].setup`; for each app
whose `ready` is false, go through `unmet`, show the person each setting's
`label`, `why` and `docs`, and read its `setup` guide, which walks through
getting the key or client. Then get the value in without it ever passing
through the chat, one of the three ways the skill's `setup/README.md`
gives: tell the person to run `setup.command.command` in their own
terminal (a hidden prompt asks for each value) and to say when it is done;
pipe a value that came from a command or a file straight into
`secret set`; or `--from-env VAR`, only for a variable the person exported
before starting the agent. Never ask for, print or repeat a value; never
invent one; never ask for a name that isn't in `unmet`. The command works
from any directory. When `command` is null and `ready` is false, the app
is another organization's: tell the person to ask the platform's operator.

## 6. How an app degrades for an optional setting

An optional setting is the feature's to explain, never a stack trace. The
SDK already answers whether the gateway holds a capability, without
calling out, and marks the gateway's own refusals apart from the
provider's errors:

```ts
import {
  gatewayRefusal,
  integrationFetch,
  integrationStatus,
} from "@every-app/sdk/server";

const NOT_SET_UP =
  "JS rendering isn't set up on this gateway: an admin sets CONTEXT_API_KEY.";

// Where the feature is offered: say so instead of showing a switch that fails.
const context = await integrationStatus({ env, provider: "context" });
if (!context.configured) return { available: false, note: NOT_SET_UP };

// Where the feature runs: the setting may have been unset since.
const render = integrationFetch({ env, provider: "context", for: request });
const response = await render("https://api.context.dev/v1/render", {
  method: "POST",
  body: JSON.stringify({ url }),
});
const refused = await gatewayRefusal(response);
if (refused?.code === "integration_not_configured") {
  return { available: false, note: NOT_SET_UP };
}
```

The same shape for the other kinds: an AI provider's calls answer
`ai_provider_not_configured` (OpenAI's error body with
`type: "gateway_refusal"`, so an OpenAI client shows the message);
`sendEmail()` throws a `GatewayRefusalError` whose `code` is
`integration_not_configured`; an app's own optional secret is simply
absent from `env`, and the feature checks for it before it starts. The
wording the ported apps use: "X isn't set up on this gateway: an admin sets
NAME". Name the setting, since the person who reads it may be the one who
sets it; never show the value.

## 7. Rolling out to a running gateway

Nothing about this model needs a value moved or a Worker touched by hand.
In order:

1. The stack is merged (#383, #395, #396, #397, #493): the gateway build
   carries `setup` on its app lists and the gate. everyapp.team runs a main
   from before it (docs/launch-2026-10-27.md, A4), so steps 2 to 5 are still
   to run there, in this order.
2. `pnpm everyapp setup` upgrades the Gateway and applies migration 0004,
   which adds `apps.secret_names`.
3. Redeploy every app whose manifest gains needs from its own repository
   (on everyapp.team: openseo, crm, analytics, agentic-inbox). Until an
   app is redeployed, the gateway evaluates the manifest it has, with
   every entry required: crm (its google-workspace, microsoft-365 and
   slack clients unset) and agentic-inbox (no Workers AI token) are closed
   under their current manifests the moment the gate deploys, so redeploy
   them first.
4. `pnpm everyapp status` reads every app's Worker and records its secret
   names; apps with secrets of their own stop reading `! not recorded`.
5. `pnpm everyapp update` deploys the gateway build with the gate (the command was `gateway deploy` before simplify stage 4, #464).

What everyapp.team's apps look like after the redeploys (registry snapshot
of 2026-10-23; the gateway holds `OPENROUTER_API_KEY`,
`DATAFORSEO_API_KEY`, `CONTEXT_API_KEY`, and `EMAIL_FROM` with
`EMAIL_FROM_NAME`):

| App           | Under the new model                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| openseo       | openrouter and dataforseo required, context optional. Ready.                                                                                                        |
| crm           | openrouter and context required; google-workspace, microsoft-365 and slack optional; all four secrets optional. Ready.                                              |
| agentic-inbox | openrouter required (its default provider), workers-ai optional (`AI_PROVIDER=workers-ai`), email required. Ready.                                                  |
| analytics     | members and `MAIN_SECRET` required, email optional. Ready once `status` records the names (unknown names never block before that).                                  |

The `todo` example app and Postiz were deleted from everyapp.team on 2026-10-24 (the simplify thread, with Ben's yes); the Gateway there runs four apps.

## 8. What this model leaves for later

Listed with the decisions in TODO.md, "Secrets model (2026-10-24)": an app
self-reporting its present secret names so the column heals without the
CLI; a provider status route so an app can pick among the set members of
a group at run time (agentic-inbox moves to `anyOf` then); the hosted
deploy API refusing a dispatch-tier manifest whose required platform
settings are unset; setting a Gateway setting from the browser when a
deployer token is configured.
