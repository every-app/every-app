import { buildCommand, buildRouteMap } from "@stricli/core";
import { SIGN_IN_PROVIDER_IDS } from "@every-app/sdk/internal";
import { CLI } from "@/lib/output/command";
import { accountFlag, gatewayFlag, jsonFlag, verboseFlag, yesFlag } from "../flags";

const connectFlags = {
  gateway: gatewayFlag,
  "account-id": accountFlag,
  json: jsonFlag,
  verbose: verboseFlag,
} as const;

const idParameter = {
  placeholder: "id",
  brief: `The sign-in provider: ${SIGN_IN_PROVIDER_IDS.join(", ")}`,
  parse: String,
} as const;

const addCommand = buildCommand({
  loader: async () => {
    const { add } = await import(".");
    return add;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [idParameter] },
    flags: {
      "client-id": {
        kind: "parsed",
        parse: String,
        brief: "The OAuth app's client id (not a secret; for apple, the Services ID)",
        optional: true,
      },
      "client-secret-from-env": {
        kind: "parsed",
        parse: String,
        brief: "Read the client secret from this environment variable (a secret never goes on the command line)",
        placeholder: "VAR",
        optional: true,
      },
      issuer: {
        kind: "parsed",
        parse: String,
        brief: "oidc: the issuer's https URL, which serves /.well-known/openid-configuration",
        placeholder: "url",
        optional: true,
      },
      label: {
        kind: "parsed",
        parse: String,
        brief: 'oidc: the button text after "Continue with" (default SSO; 40 characters at most)',
        placeholder: "text",
        optional: true,
      },
      tenant: {
        kind: "parsed",
        parse: String,
        brief:
          "microsoft: the Directory (tenant) ID that pins sign-in to your own directory (recommended), or common, organizations, consumers",
        optional: true,
      },
      ...connectFlags,
    },
  },
  docs: {
    brief: "Turn a sign-in provider on: \"Continue with Google\" (or Microsoft, GitHub, Apple, Cloudflare, your SSO)",
    fullDescription: [
      "Says where to create the OAuth app and the redirect URL to register with it",
      "(https://<gateway>/api/auth/callback/<id>), then sets the provider's settings on the",
      "Gateway Worker, all in one new version under your Cloudflare login, live on the next",
      "request. At a terminal it asks for each setting: the client id shown as typed, the",
      "client secret hidden, an optional one (microsoft's tenant, oidc's label) left as it is",
      "when you press Enter. Unattended (--json, or no terminal) every required setting comes",
      "from a flag: --client-id, --client-secret-from-env VAR, and for oidc --issuer. The",
      "client secret is never taken from the command line.",
      "",
      "A provider says who someone is; the Gateway still decides who gets in: a member, or",
      "someone with a pending invitation for that exact, verified email. Nobody else.",
      "",
      "Safe to repeat: running it again replaces the values given (a rotated secret, a new",
      `client). An optional setting not given stays as it is; ${CLI} secret unset <NAME>`,
      "removes one. The everyapp skill's setup/signin-<id>.md walks through each provider's",
      "console.",
      "",
      "Examples:",
      `  ${CLI} signin add google`,
      `  ${CLI} signin add github --client-id Iv1.0123456789abcdef --client-secret-from-env GITHUB_SECRET --json`,
      `  ${CLI} signin add microsoft --tenant 72f988bf-86f1-41af-91ab-2d7cd011db47`,
      `  ${CLI} signin add oidc --issuer https://acme.okta.com --label Okta`,
    ].join("\n"),
  },
});

const listCommand = buildCommand({
  loader: async () => {
    const { list } = await import(".");
    return list;
  },
  parameters: { positional: { kind: "tuple", parameters: [] }, flags: connectFlags },
  docs: {
    brief: "List the sign-in providers: on, needs setup (naming what is missing) or off",
    fullDescription: [
      "Reads which of each provider's settings the Gateway Worker holds (names only: a value",
      "can't be read back) and says whether the provider is on (every required setting set),",
      "needs setup (some set, the rest named; the Gateway keeps it off rather than half",
      "configured) or off. A value that is set but malformed also keeps a provider off; the",
      "Gateway's log says so (signin.config_problem). Nothing is changed.",
      "",
      "Example:",
      `  ${CLI} signin list`,
    ].join("\n"),
  },
});

const showCommand = buildCommand({
  loader: async () => {
    const { show } = await import(".");
    return show;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [idParameter] },
    flags: connectFlags,
  },
  docs: {
    brief: "Show a sign-in provider: where to make its OAuth app, the redirect URL, its settings and whether each is set",
    fullDescription: [
      "The provider's console and what the OAuth app is called there, the redirect URL to",
      "register for this Gateway, the scopes asked for (identity only), which claim becomes",
      "the email and when it counts as verified, every setting with what it holds and whether",
      "it is set, the provider's caveats and its setup guide. Nothing is changed.",
      "",
      "Example:",
      `  ${CLI} signin show apple`,
    ].join("\n"),
  },
});

const removeCommand = buildCommand({
  loader: async () => {
    const { remove } = await import(".");
    return remove;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [idParameter] },
    flags: { yes: yesFlag, ...connectFlags },
  },
  docs: {
    brief: "Turn a sign-in provider off: its settings leave the Gateway; accounts stay",
    fullDescription: [
      "Asks first (--yes doesn't), then removes every setting of the provider from the Gateway",
      "Worker in one new version: the button leaves the sign-in page on the next request.",
      "People who signed in with it keep their accounts and sign in another way (a password",
      "via Forgot password, another provider, Access). Delete the OAuth app at the provider",
      "too: a client the Gateway no longer holds is still a client.",
      "",
      "Example:",
      `  ${CLI} signin remove github`,
    ].join("\n"),
  },
});

/** `everyapp signin add|list|show|remove`: the sign-in providers beside passwords. */
export const signinRoutes = buildRouteMap({
  routes: {
    add: addCommand,
    list: listCommand,
    show: showCommand,
    remove: removeCommand,
  },
  aliases: { ls: "list" },
  docs: {
    brief: "Let people sign in with Google, Microsoft, GitHub, Apple, Cloudflare or your SSO, beside passwords",
  },
});
