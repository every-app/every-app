import { buildCommand, buildRouteMap, numberParser } from "@stricli/core";
import { CLI } from "@/lib/output/command";
import { jsonFlag, verboseFlag } from "../flags";
import {
  DEV_TOKEN_ROLES,
  parseAppId,
  parseEmail,
  parseTtl,
} from "./tokenFlags";

/** `everyapp dev` itself: run the app behind the gateway-lite. */
const runCommand = buildCommand({
  loader: async () => import("./index"),
  parameters: {
    flags: {
      port: {
        kind: "parsed",
        parse: numberParser,
        brief: "Gateway port (defaults to $PORT, then 8787)",
        optional: true,
      },
      host: {
        kind: "parsed",
        parse: String,
        brief:
          "Address the Gateway listens on (default 127.0.0.1; 0.0.0.0 lets other machines in, each as a dev identity)",
        optional: true,
      },
      mode: {
        kind: "parsed",
        parse: String,
        brief:
          "stub (seeded dev user, default) | mirror (real login through a local Gateway) | linked (a real Gateway's services as you; --gateway https://… selects it)",
        optional: true,
      },
      gateway: {
        kind: "parsed",
        parse: String,
        brief:
          "The Gateway: a real one (https://apps.example.com) links this run to it; a local one (default http://localhost:3000) is mirror mode's",
        optional: true,
      },
      baseHost: {
        kind: "parsed",
        parse: String,
        brief:
          "mirror mode: two-label base host for cookie scope (default everyapp.localhost)",
        optional: true,
      },
      "skip-migrations": {
        kind: "boolean",
        brief: "Start without applying local database migrations",
        optional: true,
      },
      json: jsonFlag,
    },
  },
  docs: {
    brief: "Run the app locally behind a dev Gateway",
    fullDescription: [
      "Runs the app under `cf dev` (or the manifest's dev command) on an internal",
      "port and a gateway-lite in front of it on $PORT (default 8787) — the REAL",
      "perimeter: public-route policy, header strip/inject, a real RS256 identity",
      "JWT, and a seeded dev user. Open http://<app-id>.localhost:8787 — the first",
      "Host label selects the app, so portless per-worktree hosts work with no",
      "configuration.",
      "",
      "Identities are signed with the SDK's well-known dev keypair, which the app's",
      "development build trusts on its own: nothing is written into the app. The",
      "key is public, so the gateway listens on 127.0.0.1 unless --host says",
      "otherwise. Before starting, dev generates the Worker's types when",
      ".cloudflare/types is missing and applies local D1 migrations",
      "(cf d1 migrations apply --local) to .cloudflare/state.",
      "",
      "With no Gateway in local runs, the app reads its manifest's secrets and the",
      "keys of its providers and capabilities (OPENROUTER_API_KEY, DATAFORSEO_API_KEY,",
      "...) from .dev.vars in its directory, one NAME=value per line, gitignored. The",
      "ready block names the ones that file is missing and the app can't run without;",
      "until they are set, AI calls and integrations answer that they aren't set up",
      "(email needs none: sendEmail() prints until EMAIL_FROM and a transport are set).",
      "",
      "Every request goes through the real perimeter (identity header, public-route",
      "policy, CSRF). Public routes are auth-optional; to call them anonymously send",
      "the header x-everyapp-dev-anon: 1 (curl) or set the cookie everyapp_dev_anon=1",
      "(browser). Requests straight to the app's internal port get 401 unless they",
      `carry an identity token in x-everyapp-identity: \`${CLI} dev token\` prints one.`,
      "",
      "An app that declares crons runs one on demand with",
      "  curl -X POST http://<app-id>.localhost:8787/__everyapp/cron -d '<schedule>'",
      "An app that receives mail gets a curl command that delivers message.eml to its",
      "email() handler: a raw message with From, To, Subject and Message-ID headers,",
      "to any address. email() gets no identity.",
      "",
      "--mode stub (default): seeded dev user, zero setup.",
      "--mode mirror: authenticate against a SEPARATELY-running local Gateway",
      "  (run `pnpm dev` in apps/every-app-gateway first). Real login/launcher",
      "  are forwarded to it. Requires a two-label base host (e.g.",
      "  everyapp.localhost) so the session cookie crosses the subdomain",
      "  boundary; the CLI prints setup guidance if the host is unusable.",
      "  Also settable via EVERYAPP_DEV_MODE; the flag wins.",
      "--gateway https://<your gateway> (linked dev): the app runs here as you,",
      "  and its AI, email, provider, member and event calls go through that",
      "  Gateway, with no provider key on this computer. The first run signs you",
      "  in once in the browser (owners and admins, on a workspace that ran",
      "  `everyapp workspace linked-dev on`); the token lives in",
      "  ~/.config/everyapp/linked-dev.json, never in the app. Calls bill the",
      "  workspace's providers. Data (D1, KV, R2) stays local; the app's own",
      "  secrets still come from .dev.vars. `everyapp dev unlink` signs out.",
      "",
      "Ctrl+C stops the app and exits with 130.",
    ].join("\n"),
  },
});

const tokenCommand = buildCommand({
  loader: async () => import("./token"),
  parameters: {
    positional: { kind: "tuple", parameters: [] },
    flags: {
      role: {
        kind: "enum",
        values: DEV_TOKEN_ROLES,
        default: "owner",
        brief: "The organization role the token carries",
      },
      user: {
        kind: "parsed",
        parse: parseEmail,
        placeholder: "email",
        brief: "Who the token speaks for (default: the dev user for owner, <role>@everyapp.localhost otherwise)",
        optional: true,
      },
      org: {
        kind: "parsed",
        parse: String,
        placeholder: "id",
        brief: "The organization id (default dev-org, the dev user's)",
        optional: true,
      },
      app: {
        kind: "parsed",
        parse: parseAppId,
        placeholder: "id",
        brief: "The app id the token is for (default: everyapp.config.ts's id in this directory)",
        optional: true,
      },
      ttl: {
        kind: "parsed",
        parse: parseTtl,
        placeholder: "duration",
        brief: "How long it lasts: seconds, or 90s, 15m, 1h (default 1h, at most 24h)",
        optional: true,
      },
      json: jsonFlag,
    },
  },
  docs: {
    brief: "Print a dev identity token for scripts that call the app's dev port",
    fullDescription: [
      `Prints an identity token the app accepts while it runs under \`${CLI} dev\`, for`,
      "scripts and curl that call the app's internal dev port directly as someone other",
      "than the gateway-lite's seeded user: a member, an admin, another organization.",
      "Send it as the x-everyapp-identity header. The gateway-lite itself replaces that",
      "header with its own, so use the internal port the ready block prints (App port).",
      "",
      "The token is minted as the gateway-lite mints its own: the SDK's well-known dev",
      "key and kid, the dev issuer https://gateway.dev.localhost, aud = the app id, a",
      "full session (channel web, scopes *). Only a development build of the app",
      "(EVERYAPP_DEV, set by everyAppWorker() under dev) accepts it; a deployed app",
      "refuses it whatever it says.",
      "",
      "Without --user, owner is the dev user (dev@everyapp.localhost, sub dev-user);",
      "admin and member are people of their own (<role>@everyapp.localhost, sub",
      "dev-<role>). With --user, the sub is dev-<email>. Agent tools are reached through",
      "<app-id>.localhost:8787/mcp, not with this token.",
      "",
      "Prints the token alone; --json prints a done event whose data has token,",
      "expiresAt, header, appId and user.",
      "",
      "Examples:",
      `  curl -H "x-everyapp-identity: $(${CLI} dev token --role member)" http://127.0.0.1:<app port>/api/me`,
      `  ${CLI} dev token --user ana@example.com --role admin --ttl 15m`,
      `  ${CLI} dev token --app my-app --org other-org --json`,
    ].join("\n"),
  },
});

const linkFlags = {
  gateway: {
    kind: "parsed",
    parse: String,
    brief: "The Gateway's URL (else EVERYAPP_GATEWAY_URL)",
    optional: true,
  },
  app: {
    kind: "parsed",
    parse: parseAppId,
    placeholder: "id",
    brief: "The app id (default: everyapp.config.ts's id in this directory)",
    optional: true,
  },
  json: jsonFlag,
  verbose: verboseFlag,
} as const;

const linkCommand = buildCommand({
  loader: async () => (await import("./link")).link,
  parameters: { positional: { kind: "tuple", parameters: [] }, flags: linkFlags },
  docs: {
    brief: "Sign everyapp dev in to a Gateway for this app (linked dev), without running it",
    fullDescription: [
      "Opens the browser at the Gateway's sign-in: approve everyapp dev, and the token for this",
      "app is kept in ~/.config/everyapp/linked-dev.json (0600). `everyapp dev --gateway <url>`",
      "does the same on its first run; this is for doing the browser step on its own, or again",
      "(a new sign-in replaces the earlier one). Owners and admins who can open the app, on a",
      "workspace with linked dev on (`everyapp workspace linked-dev on`); otherwise the Gateway",
      "says why (LINKED_DEV_REFUSED, LINKED_DEV_REGISTRATION_OFF, LINKED_DEV_OAUTH_OFF).",
      "",
      "Examples:",
      `  ${CLI} dev link --gateway https://apps.example.com`,
    ].join("\n"),
  },
});

const unlinkCommand = buildCommand({
  loader: async () => (await import("./link")).unlink,
  parameters: { positional: { kind: "tuple", parameters: [] }, flags: linkFlags },
  docs: {
    brief: "Sign everyapp dev out of a Gateway for this app: revoke the grant there and forget the token",
    fullDescription: [
      "Revokes the linked dev grant at the Gateway (it also disappears from Settings → Connections",
      "there) and removes the token from ~/.config/everyapp/linked-dev.json. If the Gateway can't",
      "be reached the token is still forgotten (warning LINKED_DEV_REVOKE_FAILED): revoke it under",
      "Settings → Connections.",
      "",
      "Examples:",
      `  ${CLI} dev unlink --gateway https://apps.example.com`,
    ].join("\n"),
  },
});

/**
 * `everyapp dev` runs the app (the default command, so its flags work as
 * before); `everyapp dev token` mints a dev identity for scripts; `dev link`
 * and `dev unlink` sign in to and out of a Gateway for linked dev.
 */
export const devRoutes = buildRouteMap({
  routes: { run: runCommand, token: tokenCommand, link: linkCommand, unlink: unlinkCommand },
  defaultCommand: "run",
  docs: {
    brief: "Run the app locally behind a dev Gateway",
    hideRoute: { run: true },
  },
});
