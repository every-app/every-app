/**
 * OAuth presets: ready `oauth2-user` specs, in the JSON shape `everyapp
 * provider add` takes, for providers people most often want a "Connect"
 * button for. A preset becomes a `providers` row when added (`everyapp
 * provider add --oauth github-oauth`, the Admin dialog,
 * `everyapp_provider_add` with `preset`), so an operator may `provider
 * show` and edit a copy; nothing here is a hidden catalog entry, and no
 * gateway reserves a preset's setting names until it is added. Google,
 * Microsoft and Slack are built in (./oauthBuiltIns.ts) and are offered
 * in the same picker.
 *
 * Each preset parses with `parseProviderSpec` (oauthPresets.test.ts) and
 * names a console where the client is made, the API hosts the token is
 * sent to, and how the provider spells scopes. Which scopes a connection
 * holds is each app's `everyapp.config.ts`, never the preset. Endpoints
 * were checked against the providers' docs on 2026-10-25; only GitHub's
 * and Google's have been tried against a live connect.
 */
import {
  parseProviderSpec,
  type RegistrableCapability,
} from "./providerSpec.js";

/** A preset's spec as JSON: the shape of ./oauthSpec.ts. */
export type OAuthPresetSpec = Readonly<Record<string, unknown>>;

export const OAUTH_PRESETS: Readonly<Record<string, OAuthPresetSpec>> = {
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
    hint: "Register an OAuth App (not a GitHub App) and paste its client id and secret. GitHub's `repo` scope is read and write.",
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
    hint: "Notion has no scopes: an app lists scopes: [] and the person picks the pages to share on Notion's consent screen. Make the integration public to get a client id and secret. Apps send `Notion-Version` on every call.",
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
    hint: "Linear's scopes are read, write, issues:create and comments:create; its API is GraphQL over POST.",
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
    hint: "Calls go to api.atlassian.com/ex/jira/<cloud id>/… ; the cloud id comes from /oauth/token/accessible-resources.",
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
    hint: "`token_access_type=offline` is what yields a refresh token.",
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
};

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

/** Whether `capability` is an OAuth provider the Gateway runs the flow for. */
export function isOAuthProvider(
  capability: { mode: string; flow?: unknown } | undefined,
): boolean {
  return capability?.mode === "oauth_client" && capability.flow !== undefined;
}
