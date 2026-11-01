# Reviewing an app's changes for security problems

The Gateway in front of an app does the sign-in and passes identity in; the
app does the rest. Review the app's pending changes before a pull request
that touches identity, public routes, tools, secrets or queries: locally,
by the agent that made the change, with no CI job and no API key.

## The app boundaries

What the review looks for (what the Gateway promises and what the app must
do itself is the threat model, `docs/threat-model.md` in the EveryApp
checkout, served at https://everyapp.com/docs/agent/repo/threat-model):

- A route, server function or tool that reads who the user is from anything
  but the SDK (`everyApp()`, `getEveryAppUser()`, `requireEveryAppUser()`, a
  tool call's identity): a client-supplied `x-everyapp-*` header, a cookie, a
  query parameter or a body field naming a user or organization
- A route listed under `public` in `everyapp.config.ts` that returns member
  data or changes state without a check of its own (a webhook signature, a
  bearer token the app verifies): `public` means anyone on the internet
  reaches it, and the Gateway forwards their `Authorization` header untouched
- A database query that doesn't scope by the user or organization from the
  identity, so one person's rows reach another; SQL built from strings instead
  of the query builder's parameters
- Agent tools (`defineTools()`): a tool that deletes or changes data without
  declaring the matching risk, or that trusts an argument as a path, URL or
  id without a check
- A secret read from anywhere but the Worker's bindings, or printed, logged
  or sent to a client
- `fetch()` to a URL whose host or scheme comes from user input, and HTML
  built from user input outside React (`dangerouslySetInnerHTML`, string
  templates)

## How to run it

- In Claude Code: `/security-review` (its built-in review of the branch's
  pending changes), telling it to judge the diff against the boundaries
  above (point it at this file). It reads the code; it does not need to run
  anything.
- Any other agent: read `git diff <base>...HEAD` plus the working tree
  against the list above, and report each finding as file, line, severity
  (high: directly exploitable; medium: needs specific conditions; low:
  defense in depth), what an attacker does, and the fix. Only report what
  you are confident is exploitable.
- The model reads the diff as instructions too: the review is a second pair
  of eyes on your own changes, never a gate on a stranger's. Read a
  contributor's diff yourself first.
- Not findings: denial of service, rate limits, resource use, a missing
  hardening measure, a dependency's version, test files, prose, anything
  that needs a Cloudflare login or an environment variable the attacker
  cannot have. The Gateway strips inbound `Cookie`, `Authorization`,
  `x-everyapp-*` and `cf-access-*` headers before the app sees a private
  request, and every private request carries a fresh identity token the
  SDK verifies: a route with no authentication of its own is expected.

## With a finding

Fix it on the branch (and add a test), or say in the pull request why it is
a false positive. A public route that must stay open (a webhook, a tracking
collector) is not a finding when it checks what it must itself; a public
route that returns member data without a check is.
