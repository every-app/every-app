# App settings: what an app needs, and whether it is set

Status: decided 2026-10-23 and built 2026-10-24 as a stack on #383 (the
model) with one pull request per surface, the `t3/launch-secrets-*`
branches: the CLI, the gateway's app lists and registry, the gate and
`/mcp`, and these documents; each live app gets a manifest pull request in
its own repository. This is the reference the public docs page is written
from. [docs/capabilities.md](capabilities.md) says what each capability is
and how an app calls it; this document says how an app declares what it
needs, how the gateway and the CLI tell whether it is set, and what happens
while it isn't. TODO.md's "Secrets model (2026-10-24)" section held every
default the builders chose (its history at `673bed8c8`).

## 1. A setting

An app's `everyapp.config.ts` names what the app needs before it works
fully: the AI providers it calls, the capabilities it uses through the
gateway, and the secrets of its own. Each is a **setting**: one thing an
operator sets once. `pnpm everyapp configure <app>` asks for each one the
app lacks; `pnpm everyapp secret set NAME` sets one by name. Four kinds,
two holders:

| Kind         | Declared as                                        | Held on              | "Set" means                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------ | -------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`   | `providers: ["openrouter"]`                        | the Gateway Worker   | its key is set: `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, or for Workers AI `WORKERS_AI_API_TOKEN` (`CLOUDFLARE_ACCOUNT_ID` is the install's own, set by `everyapp setup`, and never asked for)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `capability` | `capabilities: { dataforseo: { access: "read" } }` | the Gateway Worker   | its required Gateway settings are set: an API-key capability's key; an OAuth provider's client id and secret; a service's `settings` (`members` has none, so it is always set). A capability's optional settings are read when set and never required. The gateway may answer by the capability's own rule instead of its names: email is configured once a sender parses and a provider is selectable (`isEmailConfigured()`). The model names `EMAIL_FROM` and `EMAIL_FROM_NAME` for it, since the sender needs a display name; `EMAIL_FROM="Name <address>"` carries the name too, which the gateway reads and the CLI, reading names alone, cannot; a bare address is not configured |
| `secret`     | `secrets: ["MAIN_SECRET"]`                         | the app's own Worker | the name is set on the app's Worker                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

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

## 2. Needs and features

Every setting has a **need**, which says what happens while it is unset:

- **`required`**: everything the manifest lists at its top level, and the
  values of a required feature. The app does not open until it is set: the
  gateway shows it as "Needs setup", answers its routes with a redirect or
  a 503, and leaves its tools out of `/mcp` (§4).
- **`optional`**: a value of an optional feature, or a capability or
  provider an optional feature lists. The app opens; the feature that uses
  it says what is missing, where it is used (§6). A plain setting with a
  `default` is optional too: the deploy writes the default.

A **feature** (`features.<id>`) groups what a person sets up together: a
name, a `why`, numbered `steps` (Markdown, `{appUrl}` and `{gatewayUrl}`
filled in where shown), its own `secrets` and `settings`, and the ids of
the `capabilities` and `providers` it needs (each declared at the top level
too). `required: true` makes every value required; an optional feature
(the default) is all or nothing, and its state is `off` while none of its
own values is set, `incomplete` while some are (a warning, never a block),
`ready` once all are and every Gateway setting it needs is.

The rule for authors: required means the app is useless without it. A
setting only one feature needs goes in an optional feature. Public routes
close with the app, so weigh `required` against the public surface: a
tracker whose `MAIN_SECRET` is required goes dark at `/collect` along with
its dashboards.

An app's own value may also say `how`: where it lives and what permission
it needs (200 characters at most, placeholders allowed). A secret may say
`generate: true` (configure makes 32 random bytes, base64url; the deploy
sets a top-level one without a `how`) or `file: true` (the prompt takes a
file's path, for a `.pem`).

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
| an OAuth provider                                      | its developer console, the "Developer console" column of the [OAuth providers table](capabilities.md#oauth-providers)                                                                                                                          |
| `email`, `members`, the AI routes, an app's own secret | none, unless the manifest gives one                                                                                                                                                                                                            |

A provider's or capability's setting also carries a `hint` that no
manifest sets: what the key is and where it comes from, from the
provider's entry in the registry (its `hint`, then each setting's own),
which `everyapp status`, `secret list` and `configure` print between `why`
and "Get it at" and an agent reads in `AppSetup` (§5). For a provider
registered on the Gateway (`everyapp provider add`, the agent docs'
providers page) it is the only setup text there is.

A setting may also carry `setup`: the everyapp skill's guide to setting it
up end to end, relative to the skill (`setup/dataforseo.md`). The guides
are the skill's own, under `packages/cli/skills/everyapp/setup/` in the
checkout and `node_modules/everyapp/skills/everyapp/setup/` in every app, with an index
in `setup/README.md`; an agent reads the guide before it asks anyone for
a value. A provider's or a capability's guide comes from the SDK
registries (`DEV_AI_PROVIDERS[id].setup`, a capability's `setup`: openai,
openrouter, workers-ai, dataforseo, context, email, google-workspace,
microsoft-365, slack and youtube, which shares `setup/google.md`; the AI
routes share `setup/openai.md`; `members` and the other 14 social clients
have none), and the manifest can't change it. An app's own values have
no guide: their feature's steps and their `how` say it.

## 3. The manifest

```ts
providers: Array<string | { id: string; why?: string; docs?: string }>
capabilities: { [id]: { access: "read" | "write"; why?: string; docs?: string } }
secrets: Array<string | { name: string; why?: string; docs?: string; how?: string; generate?: boolean; file?: boolean }>
settings: Array<{ name: string; why: string; how?: string; docs?: string; type?; values?; default? }>
features: { [id]: { name: string; why: string; required?: boolean; steps?: string[];
  settings?: Array<{ name; how?; type?; values?; default? }>;
  secrets?: Array<string | { name; how?; generate?; file? }>;
  capabilities?: string[]; providers?: string[] } }
```

A bare string is an entry with no `why` and the default `docs`. The AI
routes take no entry: `ai.routes` with anything in it is one required
setting. The field-by-field reference is
`landing-page/content/agent/manifest.md`.

**What the strict validator refuses**, besides the shapes (every message
begins `Invalid everyapp.config:` and names the field): a name declared in
two places (the top level or one feature); a feature that lists nothing to
set; a feature's capability or provider that the top level doesn't
declare, or that another feature lists too; a `{placeholder}` other than
`{appUrl}` and `{gatewayUrl}`; `generate` with `file`; a feature id that
isn't a lowercase slug; and, for every name wherever it is declared, the
name rules `secrets` always had (a Gateway setting, a reserved name, one of
the app's bindings). The gateway reads a stored manifest with the lenient
schema, which passes unknown fields through.

### Example: an OpenSEO-like app

```ts
export default {
  id: "openseo",
  providers: [{ id: "openrouter", why: "Writes audit summaries." }],
  capabilities: {
    dataforseo: { access: "read", why: "Keyword, SERP and backlink data." },
    context: { access: "read", why: "Renders JavaScript pages in audits." },
  },
  features: {
    rendering: {
      name: "JavaScript rendering",
      why: "Site audits render JavaScript-heavy pages; audits run without it.",
      capabilities: ["context"],
    },
  },
} as const;
```

With `OPENROUTER_API_KEY` set and the rest unset, the app is closed for
`DATAFORSEO_API_KEY` alone; `pnpm everyapp configure openseo` asks for it,
then asks "Set up JavaScript rendering?" and, on yes, names
`pnpm everyapp provider add context`.

## 4. Where it shows

### The gateway: home, the app library, Admin → Apps

Every app list the gateway serves (`getMyApps`, Admin → Apps' `getApps`)
carries `setup: AppSetup | null` per app (§5): null when the manifest
declares nothing to set, or the app is on the dispatch tier, whose
providers and capabilities ride the platform's settings, which the
platform checks at deploy rather than at run time. An MCP app (a provider app in the code)
(`pnpm everyapp mcp on dataforseo`: an `apps` row of tier `provider`
with no Worker) lists its capability in its generated manifest, so it reads
"Needs setup" until `DATAFORSEO_API_KEY` is set
([docs/capabilities.md](capabilities.md#mcp-apps)); it has no Worker
and nothing to configure, so its command stays
`pnpm everyapp secret set DATAFORSEO_API_KEY`. An app whose
`setup.ready` is false shows a "Needs setup" badge (a warning, placed
after the active check, so an active, bound app that isn't ready shows it)
and does not open. The card and the Admin → Apps badge open a dialog. An
owner or admin gets three steps: "Get N keys" (each setting the app can't
open without, with its `why`, its names and a "Get key" link to its
docs; one already set is ticked off, and the list re-reads every 15
seconds, so rows tick off as the command sets them), "Run this in a
terminal" (the one command, `pnpm everyapp configure <app>`, or a provider
app's `secret set`, with a copy button), and "Come back here: <app> opens
on its own". Under them, the optional settings fold to one line ("Add
later · 7 optional: Google, Microsoft 365, Slack, +4 more"). A non-admin
sees the same settings, without links, and "Ask an admin to run:". A
shared app seen from another organization carries no command
(`setup.command` is null; the platform operator fixes it). When an app's
own secret keeps it closed, the footer adds "Already set it another way?
`pnpm everyapp status` re-reads the Worker." `?setup=<appId>` on the
launcher opens the dialog, which is where a closed app sends a browser.

### What a closed app answers

The perimeter asks the gateway `needsSetup({ app, request })` after the
status and activation checks, for every private path; a route the manifest
declares public is served without asking, and the app's own code answers
for what isn't configured (since 2026-10-26: a 503 there broke webhooks
and badges and protected nothing, as a public route takes no credential).
The gateway evaluates the app's stored manifest against its own env and
the app's recorded secret names, cached per row, version and names; a
change reaches every isolate within the 30 seconds the app's row is
cached, and a redeploy, a `configure` or a `secret set` makes a new version
at once. Not
ready: an HTML GET navigation is sent (302) to
`${GATEWAY_URL}/?setup=<appId>`; anything else (an API call, a non-GET)
answers `503 { "error": "app_needs_setup", "app": "<id>" }`
with no `retry-after`. Setting names are never in the body: what the
gateway holds is the operator's to know, not a visitor's.

### `/mcp`

The gateway's `/mcp` leaves out the tools of an app that needs setup and
says so in the server instructions. `everyapp_list_apps` lists such an app
with `available: false` and
`reason: "needs setup: an admin runs pnpm everyapp configure <app>"`
(plain `"needs setup"` when the command isn't the caller's to run), so a
client holding a listen stream can learn why a tool is gone and ask. The
app host's own
`/mcp` is behind the perimeter gate above.

### `everyapp status`

For every app that declares any setting, a SETTINGS table (APP, SETTING,
WHERE, STATUS); the APP table's cell says `! needs setup`; and one
`APP_NEEDS_SETUP` problem per app (a warning, not a failure), with `Run:`
the one command, `pnpm everyapp configure <app>`, and a detail line per
unmet setting, "NAME: why". `status` reads each deployed
app's Worker's secret names and records them (below); `pending` apps and
apps whose Worker is missing are skipped. When `cf workers secrets list`
fails, one `SETTINGS_UNKNOWN` warning and the rows read as unknown, which
never blocks. `--json` carries `data.apps[].setup` (§5).

The STATUS column, on every surface the CLI renders settings:

| STATUS                       | Meaning                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `✓ set` (green)              | every name the setting needs is set                                                     |
| `! not set` (yellow)         | required and unset: the app is closed                                                   |
| `not set (optional)` (dim)   | optional and unset: the app is open, the feature says so                                |
| `not set (one of: AI model)` | a group member that is unset while another member is set                                |
| `! not recorded` (yellow)    | an app secret whose Worker's names were never recorded: run `pnpm everyapp status` once (on a Gateway from before migration 0004 the column itself is missing until `pnpm everyapp update`; status and secret list read the names as not recorded meanwhile) |

### `everyapp secret list [<app>]`

Takes an optional app id: by default the app in the current directory;
from elsewhere with no id, the Gateway's table and then every app's
settings. The same renderer and vocabulary as `status`. `--json` carries
`data.app.setup` (the `AppSetup` of §5, what the setup skills read) and
`data.app.settings`, and `next`: the one configure command while something
is unmet (before the first deploy, `{ command: "pnpm everyapp configure", note: "in the app's directory" }`,
followed by `pnpm everyapp deploy`, since the app's own secrets wait for
its Worker; an app row left `pending` by a first deploy that never
finished counts as undeployed).

### `everyapp configure <app>`

The one command that sets up an app, and the one every surface prints for
an app that needs setup. It reads the app's manifest (the registry's, as
its last deploy stored it, when the app is named, so it runs from
anywhere; the `everyapp.config.ts` here when not, which works before the
first deploy for the Gateway's settings) and what is set, then, at a
terminal: one dim line saying where values go (an AI key or a capability's
client on the Gateway Worker, once for every app; the app's own secrets on
its Worker; changes live at once, no deploy), the SETTING, WHERE, STATUS
table (names only, never values), a hidden prompt per required unset
setting with "Label: why", the provider's hint, "Get it at <docs>" and
"Guide: node_modules/everyapp/skills/everyapp/setup/<file>.md" above it (a plain setting such as
`EMAIL_FROM` gets a visible prompt with what it takes, and is checked; a
setting with several names, an OAuth client's id and secret, reads unset
while one is missing and is asked only for the missing one),
then each required feature (its name, why and numbered steps, each Gateway
setting it needs with `provider add` when unset, then a prompt per unset
value with its `how`; a `generate` secret is made and shown once when its
`how` says where to paste it; a `file` prompt takes a path), then "Set up
<name>?" for each optional feature that's off ("Finish setting up <name>?"
for one that's incomplete; No by default; Yes asks each value with "(Enter
to skip)"). An app that is ready gets a menu,
"Everything <app> needs is set. Change one?", listing every setting with
its status and "No, done". Everything is applied in one go at the end
(one new Worker version per destination, the Gateway's first), through
the same machinery as `secret set`: leases, the replaceable-version
check, the app's secret names recorded. Ctrl-C at a prompt: "Cancelled.
Nothing changed."

Without a terminal (a script, a coding agent), values come from
`NAME=value` lines on stdin (one per line; blank lines and lines starting
with `#` are skipped, an `export ` prefix is allowed, one pair of matching
quotes around the value is dropped, the value is otherwise taken as it is,
and a later line for the same name wins; a name a capability reads once
set, `EMAIL_FROM_NAME`, is taken too) or, with `--from-env`, from the
environment variable of each unset setting's own name
(`DATAFORSEO_API_KEY` from `$DATAFORSEO_API_KEY`; a name that is set
already is never replaced, so a client with one name set gets only the
other; stdin isn't read then, so a parent that keeps the pipe open never
holds the run). The two never combine. Each is checked before anything is
written: a line that isn't `NAME=value` is `PIPED_LINE_INVALID` ("Line <n>
of the piped input isn't NAME=value"; the line is never echoed, since it
may be a bare secret, which goes to `secret set NAME`), a piped name the
manifest doesn't declare is `SECRET_NOT_DECLARED` ("<app> doesn't declare
NAME" when it looks like a setting name, else "<app> doesn't declare line
<n> (not shown: it may be a value)"; fix "leave it out, or declare it in
everyapp.config.ts; a bare value goes to pnpm everyapp secret set NAME"),
an empty value `SECRET_EMPTY`, a plain setting's bad value
`SETTING_VALUE_INVALID`, one of the app's own secrets before its first
deploy `APP_NOT_FOUND`. A value never goes on the command line:
`configure NAME=value` is refused with `VALUE_ON_COMMAND_LINE`, and a
second argument or `--from-env=<value>` by the argument parser before
that (`TOO_MANY_ARGUMENTS`, `INVALID_VALUE`; the value is cut out of the
message, with "A value never goes on the command line: it lands in the
shell's history and the process list. Rotate it if it was real."). With
nothing piped, no `--from-env` variable found and a required setting
unset, the run stops with `SECRET_VALUE_REQUIRED` ("Can't ask for <app>'s
settings without a terminal", then "<app> needs <names>. Run this at a
terminal, pipe NAME=value lines in (one per line), or export them under
those names and add --from-env (which also takes the variable of any
unset optional setting)."); `data.names` lists the names still missing,
`data.rerun` is `pnpm everyapp configure <app> --from-env` (`rerunNote`
"with the variables exported") once the app is deployed and
`pnpm everyapp configure --from-env` ("in the app's directory, with the
variables exported") before its first deploy, since the name form is
refused for an undeployed app (a row left `pending` by a deploy that
never finished counts as one).

The end is `done` with "Set A, B and C. <app> is ready" (or "<app> is
ready" with nothing to set), or "Set … <app> still needs X" (the names
still missing) with the `APP_NEEDS_SETUP` warning (`data.setup`) and
`done.data.next`
`[{ command: "pnpm everyapp configure <app>", note: "at a terminal, with NAME=value lines on stdin, or with --from-env" }]`
(before the first deploy
`[{ command: "pnpm everyapp configure", note: "in the app's directory: at a terminal, with NAME=value lines on stdin, or with --from-env" }]`);
for an app not deployed yet whose Gateway settings are set, "<app>'s
Gateway settings are set; its own X and Y come after its first deploy"
with `next` `[{ command: "pnpm everyapp deploy", note: "then pnpm everyapp configure <app> for X and Y" }]`.
A failure after one destination already changed is
`SECRETS_PARTIALLY_APPLIED` with `secret set`'s message and
`data: { applied, left }`, but its rerun is `pnpm everyapp configure <app>`
(`rerunNote` "to set what is left"; before the first deploy
`pnpm everyapp configure`, "in the app's directory, to set what is left"),
retryable: it reads what is set and asks only for what is still missing.
`done.data` is `{ app: { id, deployed, setup }, set: string[], changed?: { gateway?: { names, versions }, app?: { id, workerName, names, versions } }, next? }`.
Progress lines under `--verbose`: the step named configure.env ("<NAME>
from $<NAME>") and the secret machinery's secrets.route and
secrets.version lines; the steps are secrets.gateway ("Set A and B on the
Gateway") and secrets.app ("Set C on <app>"), the same as `secret set`.

### `everyapp secret set|unset NAME... --app <id>`

One name at a time, by name, for a person who knows the name and for
scripts; `configure` walks the manifest instead and is what the surfaces
print.

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
and one `next` entry with the command, `pnpm everyapp configure crm`, and
the note "asks for each; crm opens once they are set".
`everyapp dev` enforces nothing: in dev the app reads its own `.dev.vars`.

### How app secret names are recorded

The gateway can't list an app Worker's secrets itself, so the CLI records
them: `apps.secret_names` (TEXT, a JSON `string[]`, null when never
recorded) holds the names on the app's own Worker, with everyapp's own
(`GATEWAY_URL`, `EVERY_APP_ORG_ID` and the rest it sets at deploy) left
out. Written by `deploy` (listed after the upload, in the same registry
update as the deploy itself, under the app's lease), `secret
set|unset` and `configure` (after the app's Workers are patched) and
`status` (every deployed app, each run). Read by the gateway with the rest of the app's
row. Null never blocks and reads `! not recorded`: a change made outside
the CLI (the dashboard, `cf workers secrets` by hand) or a row from before
the column heals on the next `pnpm everyapp status`.

## 5. `AppSetup`, as agents read it

One shape on every surface: `setup` on the gateway's app lists,
`data.apps[].setup` in `everyapp status --json`, and `data.app.setup` in
`everyapp secret list --json`.

```ts
interface AppSetup {
  ready: boolean; // no required setting unset
  settings: AppSetupSetting[]; // every setting, in manifest order
  unmet: AppSetupSetting[]; // the ones keeping the app closed
  features: Array<{
    id: string; name: string; required: boolean; why?: string;
    steps: string[]; capabilities: string[]; providers: string[];
    state: "off" | "incomplete" | "ready";
    settings: string[]; // its settings' ids
  }>;
  command: { command: string } | null; // "pnpm everyapp configure <app>"; null: ready, or not yours to run
}

interface AppSetupSetting {
  kind: "provider" | "capability" | "secret" | "setting" | "ai-default" | "remote-mcp";
  id: string; // provider id, capability id or secret name
  label: string; // "OpenRouter", "DataForSEO", "MAIN_SECRET"
  holder: "gateway" | "app";
  names: string[]; // every name that must be set for the setting to count as set
  need: { kind: "required" } | { kind: "optional" };
  feature?: string; // the feature it belongs to
  why?: string;
  how?: string; // an app value's: where it lives, placeholders unfilled
  generate?: boolean;
  file?: boolean;
  hint?: string; // what the key is and where it comes from: the provider entry's hint, then each setting's own (never the manifest's)
  docs?: string;
  setup?: string; // a Gateway setting's guide in the everyapp skill, "setup/email.md"; none for a provider registered on the Gateway
  set: boolean | null; // null: not known (app names never recorded); never blocks
  blocking: boolean; // required and unset
}
```

`pnpm everyapp configure <app> --json` adds `data.features`: each feature
with its steps filled in, its values (`name`, `kind`, `how`, `set`,
`generate`, `file`) and its Gateway needs (`set`, and `command` when
unset), what an agent sets an app up from end to end.

How an agent uses it (the everyapp skill's rule): run
`pnpm everyapp status --json` and read `data.apps[].setup`; for each app
whose `ready` is false, go through `unmet`, show the person each setting's
`label`, `why`, `hint` and `docs`, and read its `setup` guide, which walks
through getting the key or client (a provider registered on the Gateway
has no guide: `pnpm everyapp provider show <id>` prints its spec, and
`status`, `secret list` and `configure` print
`Guide: pnpm everyapp provider show <id>` for it). Then get the value in without it ever passing
through the chat, one of the three ways the skill's `setup/README.md`
gives: tell the person to run `setup.command.command`
(`pnpm everyapp configure <app>`, or `pnpm everyapp secret set NAME` for
one name) in their own terminal, where a hidden prompt asks for each
value, and to say when it is done; pipe what a command produced straight
in, `… | pnpm everyapp secret set NAME --json` for one value or several
at once as `NAME=value` lines into `pnpm everyapp configure <app> --json`;
or variables the person exported before starting the agent,
`pnpm everyapp configure <app> --from-env --json` (every exported name at
once) or `pnpm everyapp secret set NAME --from-env NAME --json`. Never ask
for, print or repeat a value; never invent one; never ask for a name that
isn't in `unmet`. The command works from any directory. When `command` is
null and `ready` is false, the app is another organization's: tell the
person to ask the platform's operator.

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
const render = integrationFetch({ env, provider: "context" });
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

Listed with the decisions in TODO.md's history (`673bed8c8`), "Secrets model (2026-10-24)": an app
self-reporting its present secret names so the column heals without the
CLI; a provider status route so an app can pick among the set members of
a provider at run time; the hosted
deploy API refusing a dispatch-tier manifest whose required platform
settings are unset; setting a Gateway setting from the browser when a
deployer token is configured.
