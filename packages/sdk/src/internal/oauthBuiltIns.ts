/**
 * The OAuth providers every Gateway has built in, as `oauth2-user` specs:
 * the same JSON shape as the presets (./oauthPresets.ts) and a registered
 * row (`everyapp provider add`). What differs between Google, Microsoft
 * and Slack is here as data: the endpoints, the API hosts, how scopes are
 * separated and prefixed, the extra authorize parameters, how the account
 * is named, and the scopes a token may carry beyond what the app asked.
 * No code anywhere reads a provider id to decide anything.
 *
 * Pure data with no imports, so the catalog (./capabilities.ts) can build
 * its entries from it without an import cycle. Each spec parses with
 * `parseProviderSpec` and round-trips through `oauthSpecOf`
 * (oauthBuiltIns.test.ts).
 */
export const BUILT_IN_OAUTH_SPECS = {
  // One Google Cloud project's OAuth client: Gmail, Calendar, Search
  // Console, Analytics and any other Google API an app names a scope for.
  "google-workspace": {
    id: "google-workspace",
    name: "Google",
    description:
      "Gmail, Calendar, Drive, Search Console, Analytics and the other Google APIs, as the person who connects.",
    docs: "https://console.cloud.google.com/apis/credentials",
    api: "https://developers.google.com/identity/protocols/oauth2/scopes",
    hosts: [
      "gmail.googleapis.com",
      "www.googleapis.com",
      "searchconsole.googleapis.com",
      "analyticsdata.googleapis.com",
      "analyticsadmin.googleapis.com",
      "openidconnect.googleapis.com",
    ],
    auth: {
      kind: "oauth2-user",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      clientId: "GOOGLE_WORKSPACE_CLIENT_ID",
      clientSecret: "GOOGLE_WORKSPACE_CLIENT_SECRET",
      inject: "form",
      pkce: true,
      scopeSeparator: "space",
      // An app writes `gmail.modify`; the authorize URL carries the full
      // `https://www.googleapis.com/auth/gmail.modify`.
      scopePrefix: "https://www.googleapis.com/auth/",
      // A refresh token needs `access_type=offline`; `prompt=consent`
      // makes Google issue one on every connect.
      authorizeParams: { access_type: "offline", prompt: "consent" },
      identity: {
        url: "https://openidconnect.googleapis.com/v1/userinfo",
        label: "email",
        id: "sub",
        scopes: ["openid", "email"],
      },
      // Google answers `email` and `profile` as the userinfo URLs, and may
      // add `profile` beside `openid`.
      tolerated: [
        "profile",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
      ],
    },
    hint: "A Web application OAuth client in Google Cloud, with the Gateway's callback as its redirect URI and the scopes your apps list on its consent screen.",
  },
  // The multi-tenant Entra endpoints: register the client for accounts in
  // any organization and personal accounts.
  "microsoft-365": {
    id: "microsoft-365",
    name: "Microsoft 365",
    description:
      "Outlook mail and calendar, OneDrive and the rest of Microsoft Graph, as the person who connects.",
    docs: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
    api: "https://learn.microsoft.com/graph/permissions-reference",
    hosts: ["graph.microsoft.com"],
    auth: {
      kind: "oauth2-user",
      authorizeUrl:
        "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      clientId: "MICROSOFT_365_CLIENT_ID",
      clientSecret: "MICROSOFT_365_CLIENT_SECRET",
      inject: "form",
      pkce: true,
      scopeSeparator: "space",
      // An app writes `Mail.Read`; Graph's scopes are fully qualified on
      // the wire and may come back either way.
      scopePrefix: "https://graph.microsoft.com/",
      identity: {
        url: "https://graph.microsoft.com/v1.0/me",
        label: "userPrincipalName",
        id: "id",
        // `offline_access` is what makes Entra issue a refresh token.
        scopes: ["User.Read", "offline_access"],
      },
      tolerated: ["openid", "profile", "email"],
    },
    hint: "An app registration in Entra for accounts in any organization and personal accounts, with the Gateway's callback as a Web redirect URI. If two apps share this client with different scopes, Microsoft may hand back both apps' scopes and the Gateway refuses the token: give each app its own client.",
  },
  // A Slack app's bot token: the top-level token of `oauth.v2.access`.
  slack: {
    id: "slack",
    name: "Slack",
    description: "Channels, members and messages, as the Slack app.",
    docs: "https://api.slack.com/apps",
    api: "https://api.slack.com/scopes",
    hosts: ["slack.com"],
    auth: {
      kind: "oauth2-user",
      authorizeUrl: "https://slack.com/oauth/v2/authorize",
      tokenUrl: "https://slack.com/api/oauth.v2.access",
      revokeUrl: "https://slack.com/api/auth.revoke",
      clientId: "SLACK_CLIENT_ID",
      clientSecret: "SLACK_CLIENT_SECRET",
      inject: "form",
      // Slack refuses `code_challenge`.
      pkce: false,
      scopeSeparator: "comma",
      identity: {
        url: "https://slack.com/api/auth.test",
        label: "team",
        id: "team_id",
      },
    },
    hint: "A Slack app with the Gateway's callback as its redirect URL and the bot scopes your apps list.",
  },
} as const;

export type BuiltInOAuthId = keyof typeof BUILT_IN_OAUTH_SPECS;
