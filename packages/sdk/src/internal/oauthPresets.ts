/**
 * The OAuth providers, as presets: ready `oauth2-user` specs in the JSON
 * shape `everyapp provider add` takes. Every OAuth provider a Gateway
 * serves is a `providers` row, and a preset is that row's spec, written
 * when an app whose manifest names the preset's id is deployed or
 * installed, or when an operator adds it (`everyapp provider add
 * google-workspace`, the Admin dialog, `everyapp_provider_add` with
 * `preset`). An operator may `provider show` and edit the row's copy. No
 * gateway reserves a preset's setting names until its row is written.
 * What differs between providers is data here: the endpoints, the API
 * hosts, how scopes are separated and prefixed, the extra authorize
 * parameters, how the account is named, and the scopes a token may carry
 * beyond what the app asked. No code reads a provider id to decide
 * anything.
 *
 * Each preset parses with `parseProviderSpec` (oauthPresets.test.ts) and
 * names a console where the client is made, the API hosts the token is
 * sent to, and how the provider spells scopes. Which scopes a connection
 * holds is each app's `everyapp.config.ts`, never the preset. Endpoints
 * were checked against the providers' docs on 2026-10-25; only GitHub's
 * and Google's have been tried against a live connect.
 *
 * A row is a copy: changing a preset here changes no Gateway that has
 * written its row already. A change that must reach them ships with a D1
 * data migration (as 0032 wrote the first rows) that rewrites the rows
 * still equal to the old spec and moves `bound_to` (and a pasted client's
 * `oauth_clients.bound_to`) from the old binding key to the new one, so
 * the client keeps being read and `isPresetRow` keeps matching.
 */
import type { CapabilityLookup } from "./capabilities.js";
import { providerBindingKey } from "./providerRegistry.js";
import {
  parseProviderSpec,
  type RegistrableCapability,
} from "./providerSpec.js";

/** A preset's spec as JSON: the shape of ./oauthSpec.ts. */
export type OAuthPresetSpec = Readonly<Record<string, unknown>>;

const PRESETS = {
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
      // A disconnect revokes the grant: POST form `token=` (RFC 7009), the
      // refresh token once the access token has expired.
      revokeUrl: "https://oauth2.googleapis.com/revoke",
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
    hint: "A Web application OAuth client in Google Cloud, with the scopes your apps list on its consent screen.",
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
    hint: "An app registration in Entra for accounts in any organization and personal accounts, with a Web redirect URI.",
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
    hint: "A Slack app with the bot scopes your apps list. Paste its Client ID and Client Secret, not a bot token (`xoxb-`).",
  },
  "github-oauth": {
    id: "github-oauth",
    name: "GitHub",
    description:
      "Repositories, issues, pull requests and the person's profile.",
    docs: "https://github.com/settings/developers",
    api: "https://docs.github.com/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps",
    hosts: ["api.github.com"],
    auth: {
      kind: "oauth2-user",
      authorizeUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      revokeUrl: "https://api.github.com/applications/{client_id}/grant",
      revokeMethod: "DELETE",
      clientId: "GITHUB_OAUTH_CLIENT_ID",
      clientSecret: "GITHUB_OAUTH_CLIENT_SECRET",
      inject: "form",
      pkce: true,
      scopeSeparator: "comma",
      tokenHeaders: { Accept: "application/json" },
      // GET /user answers with the public profile under any token.
      identity: {
        url: "https://api.github.com/user",
        label: "login",
        id: "id",
      },
    },
    hint: "An OAuth App, not a GitHub App.",
  },
  "notion-oauth": {
    id: "notion-oauth",
    name: "Notion",
    description: "Pages and databases the person shares with the integration.",
    docs: "https://www.notion.so/my-integrations",
    api: "https://developers.notion.com/reference",
    hosts: ["api.notion.com"],
    auth: {
      kind: "oauth2-user",
      authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
      tokenUrl: "https://api.notion.com/v1/oauth/token",
      clientId: "NOTION_OAUTH_CLIENT_ID",
      clientSecret: "NOTION_OAUTH_CLIENT_SECRET",
      inject: "basic",
      pkce: false,
      scopeSeparator: "space",
      authorizeParams: { owner: "user" },
    },
    hint: "A public integration: only a public one has a client ID and secret.",
  },
  "linear-oauth": {
    id: "linear-oauth",
    name: "Linear",
    description: "Issues, projects and teams, over Linear's GraphQL API.",
    docs: "https://linear.app/settings/api/applications",
    api: "https://developers.linear.app/docs/oauth/authentication",
    hosts: ["api.linear.app"],
    auth: {
      kind: "oauth2-user",
      authorizeUrl: "https://linear.app/oauth/authorize",
      tokenUrl: "https://api.linear.app/oauth/token",
      revokeUrl: "https://api.linear.app/oauth/revoke",
      clientId: "LINEAR_OAUTH_CLIENT_ID",
      clientSecret: "LINEAR_OAUTH_CLIENT_SECRET",
      inject: "form",
      pkce: false,
      scopeSeparator: "comma",
    },
  },
  "gitlab-oauth": {
    id: "gitlab-oauth",
    name: "GitLab",
    description: "Projects, merge requests and issues on gitlab.com.",
    docs: "https://gitlab.com/-/user_settings/applications",
    api: "https://docs.gitlab.com/integration/oauth_provider/#view-all-authorized-applications",
    hosts: ["gitlab.com"],
    auth: {
      kind: "oauth2-user",
      authorizeUrl: "https://gitlab.com/oauth/authorize",
      tokenUrl: "https://gitlab.com/oauth/token",
      revokeUrl: "https://gitlab.com/oauth/revoke",
      clientId: "GITLAB_OAUTH_CLIENT_ID",
      clientSecret: "GITLAB_OAUTH_CLIENT_SECRET",
      inject: "form",
      pkce: true,
      scopeSeparator: "space",
      identity: {
        url: "https://gitlab.com/api/v4/user",
        label: "username",
        id: "id",
        scopes: ["read_user"],
      },
    },
    hint: "A self-managed GitLab needs a custom provider with its own host in place of gitlab.com.",
  },
  atlassian: {
    id: "atlassian",
    name: "Atlassian (Jira and Confluence)",
    description:
      "Jira issues and Confluence pages on the sites the person grants.",
    docs: "https://developer.atlassian.com/console/myapps/",
    api: "https://developer.atlassian.com/cloud/jira/platform/scopes-for-oauth-2-3LO-and-forge-apps/",
    hosts: ["api.atlassian.com"],
    auth: {
      kind: "oauth2-user",
      authorizeUrl: "https://auth.atlassian.com/authorize",
      tokenUrl: "https://auth.atlassian.com/oauth/token",
      clientId: "ATLASSIAN_CLIENT_ID",
      clientSecret: "ATLASSIAN_CLIENT_SECRET",
      inject: "form",
      pkce: false,
      scopeSeparator: "space",
      authorizeParams: { audience: "api.atlassian.com", prompt: "consent" },
      identity: {
        url: "https://api.atlassian.com/me",
        label: "email",
        id: "account_id",
        // `offline_access` is what yields a refresh token.
        scopes: ["read:me", "offline_access"],
      },
    },
  },
  "hubspot-oauth": {
    id: "hubspot-oauth",
    name: "HubSpot",
    description: "CRM contacts, companies and deals.",
    docs: "https://developers.hubspot.com/",
    api: "https://developers.hubspot.com/docs/api/working-with-oauth",
    hosts: ["api.hubapi.com"],
    auth: {
      kind: "oauth2-user",
      authorizeUrl: "https://app.hubspot.com/oauth/authorize",
      tokenUrl: "https://api.hubapi.com/oauth/v1/token",
      clientId: "HUBSPOT_OAUTH_CLIENT_ID",
      clientSecret: "HUBSPOT_OAUTH_CLIENT_SECRET",
      inject: "form",
      pkce: false,
      scopeSeparator: "space",
    },
    hint: "The app's scopes in HubSpot's developer console must include the scopes apps list, or HubSpot refuses the authorize URL.",
  },
  zoom: {
    id: "zoom",
    name: "Zoom",
    description: "The person's meetings and recordings.",
    docs: "https://marketplace.zoom.us/develop/create",
    api: "https://developers.zoom.us/docs/integrations/oauth-scopes-overview/",
    hosts: ["api.zoom.us"],
    auth: {
      kind: "oauth2-user",
      authorizeUrl: "https://zoom.us/oauth/authorize",
      tokenUrl: "https://zoom.us/oauth/token",
      revokeUrl: "https://zoom.us/oauth/revoke",
      clientId: "ZOOM_CLIENT_ID",
      clientSecret: "ZOOM_CLIENT_SECRET",
      inject: "basic",
      pkce: true,
      scopeSeparator: "space",
      identity: {
        url: "https://api.zoom.us/v2/users/me",
        label: "email",
        id: "id",
        scopes: ["user:read:user"],
      },
    },
    hint: "A General app with user-managed OAuth, using Zoom's granular scope names.",
  },
  dropbox: {
    id: "dropbox",
    name: "Dropbox",
    description: "Files and folders in the person's Dropbox.",
    docs: "https://www.dropbox.com/developers/apps",
    api: "https://developers.dropbox.com/oauth-guide",
    hosts: ["api.dropboxapi.com", "content.dropboxapi.com"],
    auth: {
      kind: "oauth2-user",
      authorizeUrl: "https://www.dropbox.com/oauth2/authorize",
      tokenUrl: "https://api.dropboxapi.com/oauth2/token",
      revokeUrl: "https://api.dropboxapi.com/2/auth/token/revoke",
      clientId: "DROPBOX_OAUTH_CLIENT_ID",
      clientSecret: "DROPBOX_OAUTH_CLIENT_SECRET",
      inject: "form",
      pkce: true,
      scopeSeparator: "space",
      authorizeParams: { token_access_type: "offline" },
      // Dropbox grants account_info.read to every app.
      tolerated: ["account_info.read"],
    },
  },
  spotify: {
    id: "spotify",
    name: "Spotify",
    description: "The person's library, playlists and listening.",
    docs: "https://developer.spotify.com/dashboard",
    api: "https://developer.spotify.com/documentation/web-api/concepts/scopes",
    hosts: ["api.spotify.com"],
    auth: {
      kind: "oauth2-user",
      authorizeUrl: "https://accounts.spotify.com/authorize",
      tokenUrl: "https://accounts.spotify.com/api/token",
      clientId: "SPOTIFY_CLIENT_ID",
      clientSecret: "SPOTIFY_CLIENT_SECRET",
      inject: "basic",
      pkce: true,
      scopeSeparator: "space",
      // GET /v1/me names the account under any token.
      identity: {
        url: "https://api.spotify.com/v1/me",
        label: "display_name",
        id: "id",
      },
    },
  },
} as const satisfies Record<string, OAuthPresetSpec>;

/** The id of an OAuth provider the SDK ships a preset for (`google-workspace`, `github-oauth`, ...). */
export type OAuthPresetId = keyof typeof PRESETS;

/** Every preset by id, in the order the picker shows them. */
export const OAUTH_PRESETS: Readonly<Record<string, OAuthPresetSpec>> = PRESETS;

/** The agent docs' setup guides for a preset's client, where one exists. */
const SETUP_GUIDES: Readonly<Record<string, string>> = {
  "google-workspace": "setup/google.md",
  "microsoft-365": "setup/microsoft-365.md",
  slack: "setup/slack.md",
};

/** The setup guide for OAuth provider `id`'s client, when its preset has one (`setup` in an app's settings report). */
export function oauthSetupGuide(id: string): string | undefined {
  return SETUP_GUIDES[id];
}

/** The preset ids, in the order the picker shows them. */
export function oauthPresetIds(): string[] {
  return Object.keys(OAUTH_PRESETS);
}

/** A preset's parsed capability, for the picker's labels; throws for an unknown id (the test parses every preset). */
export function oauthPreset(id: string): RegistrableCapability | null {
  const spec = OAUTH_PRESETS[id];
  if (!spec) return null;
  const parsed = parseProviderSpec(spec);
  if (!parsed.ok) {
    throw new Error(
      `preset ${id} doesn't parse: ${JSON.stringify(parsed.problems)}`,
    );
  }
  return parsed.capability;
}

/**
 * Whether `capability`, a Gateway's row for `id`, is that preset's: its
 * client would go to the preset's endpoints and hosts under the preset's
 * setting names (the same binding key). Adding the preset again takes the
 * client for such a row; a row of another spec under a preset's id is the
 * operator's own and is never taken for the preset.
 */
export function isPresetRow(
  id: string,
  capability: RegistrableCapability,
): boolean {
  const preset = oauthPreset(id);
  return (
    preset !== null &&
    providerBindingKey(capability) === providerBindingKey(preset)
  );
}

/**
 * The preset ids among `ids` (an app's capabilities) that `lookup` (a
 * Gateway's registry) doesn't have: the rows a deploy or an install
 * writes from their presets before it checks the manifest.
 */
export function unregisteredPresetIds(
  ids: Iterable<string>,
  lookup: Pick<CapabilityLookup, "get">,
): string[] {
  return [...new Set(ids)].filter(
    (id) => Object.hasOwn(OAUTH_PRESETS, id) && lookup.get(id) === undefined,
  );
}

/**
 * `lookup` with every preset it lacks, as the row it would be: what a
 * local run (`everyapp dev`) and a check made before a Gateway is asked
 * read, since a deploy writes the row of any preset an app names.
 */
export function withOAuthPresets(lookup: CapabilityLookup): CapabilityLookup {
  const presets = oauthPresetIds().filter((id) => !lookup.get(id));
  return {
    get: (id) =>
      lookup.get(id) ??
      (presets.includes(id) ? (oauthPreset(id) ?? undefined) : undefined),
    ids: () => [...lookup.ids(), ...presets],
  };
}
