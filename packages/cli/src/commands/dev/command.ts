import { buildCommand } from "@stricli/core";
import { numberParser } from "@stricli/core";

export const devCommand = buildCommand({
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
          "Address the gateway listens on (default 127.0.0.1; 0.0.0.0 lets other machines in, each as a dev identity)",
        optional: true,
      },
      mode: {
        kind: "parsed",
        parse: String,
        brief:
          "stub (seeded dev user, default) | mirror (real login via local gateway)",
        optional: true,
      },
      gateway: {
        kind: "parsed",
        parse: String,
        brief:
          "mirror mode: URL of the separately-run local gateway (default http://localhost:3000)",
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
      "Every request goes through the real perimeter (identity header, public-route",
      "policy, CSRF). Public routes are auth-optional; to call them anonymously send",
      "the header x-everyapp-dev-anon: 1 (curl) or set the cookie everyapp_dev_anon=1",
      "(browser). Requests straight to the app's internal port get 401, by design.",
      "",
      "--mode stub (default): seeded dev user, zero setup.",
      "--mode mirror: authenticate against a SEPARATELY-running local gateway",
      "  (run `pnpm dev` in apps/every-app-gateway first). Real login/launcher",
      "  are forwarded to it. Requires a two-label base host (e.g.",
      "  everyapp.localhost) so the session cookie crosses the subdomain",
      "  boundary; the CLI prints setup guidance if the host is unusable.",
      "  Also settable via EVERYAPP_DEV_MODE; the flag wins.",
    ].join("\n"),
  },
});
