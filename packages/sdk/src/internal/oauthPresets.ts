/**
 * OAuth presets (docs/design/2026-10-oauth-providers.md section 4): ready
 * `oauth2-user` specs, in the JSON shape `everyapp provider add` takes,
 * for the providers people most often want a "Connect" button for. A
 * preset becomes a `providers` row when added (`everyapp provider add
 * --oauth github`, the Admin dialog, `everyapp_provider_add` with
 * `preset`), so an operator may `provider show` and edit a copy; nothing
 * here is a hidden catalog entry. Google, Microsoft, Slack and Discord
 * are catalog clients with a `flow` and are offered in the same picker.
 *
 * Each preset parses with `parseProviderSpec` (oauthPresets.test.ts),
 * names a console where the client is made, the API hosts the token is
 * sent to, and scope sets an app declares under `scopes`. Scope strings
 * are the providers' own, verified against their docs on 2026-10-25.
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
    api: "https://docs.github.com/rest",
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
      scopeDialect: "comma",
      tokenHeaders: { Accept: "application/json" },
      identity: {
        url: "https://api.github.com/user",
        label: "login",
        id: "id",
      },
    },
    scopeSets: {
      identity: {
        label: "GitHub account (who you are)",
        access: "read",
        scopes: ["read:user", "user:email"],
      },
      "repo.read": {
        label: "Repositories (read, private ones included)",
        access: "read",
        scopes: ["repo"],
      },
      "repo.write": {
        label: "Repositories (read and write)",
        access: "write",
        scopes: ["repo"],
      },
      "org.read": {
        label: "Organizations and teams (read)",
        access: "read",
        scopes: ["read:org"],
      },
    },
    access: ["read", "write"],
    hint: "Register an OAuth App (not a GitHub App) and paste its client id and secret. GitHub's `repo` scope is read and write; a read set with it still lets the Gateway refuse writes.",
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
      scopeDialect: "space",
      authorizeParams: { owner: "user" },
    },
    // Notion reads with GET, and with POST for a search and a database
    // query; the read set lists those two, so a read grant never creates
    // or changes a page (POST /v1/pages, PATCH, DELETE need the write set).
    scopeSets: {
      "workspace.read": {
        label: "Shared pages and databases (read)",
        access: "read",
        scopes: [],
        routes: [
          {
            host: "api.notion.com",
            paths: [
              "/v1/users",
              "/v1/users/",
              "/v1/pages/",
              "/v1/databases/",
              "/v1/blocks/",
              "/v1/comments",
            ],
            posts: ["^/v1/search$", "^/v1/databases/[^/]+/query$"],
          },
        ],
      },
      "workspace.write": {
        label: "Shared pages and databases (read and write)",
        access: "write",
        scopes: [],
      },
    },
    access: ["read", "write"],
    hint: "Notion has no scopes: the person picks the pages to share on Notion's consent screen. Make the integration public to get a client id and secret. Apps send `Notion-Version` on every call.",
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
      scopeDialect: "comma",
    },
    // Linear's API is one GraphQL POST, which the Gateway can't tell a
    // query from a mutation on, so the one set is a write set: an app
    // lists Linear with access: "write", and Linear's own `read` scope is
    // what a read-only token holds.
    scopeSets: {
      "workspace.write": {
        label: "Issues, projects and teams (read and write)",
        access: "write",
        scopes: ["read", "write"],
      },
    },
    access: ["write"],
    readMethods: [],
    writeMethods: ["POST"],
    hint: "Linear's API is GraphQL over POST, so every call needs access: \"write\"; a token's scopes decide what a query may change.",
  },
  "gitlab-oauth": {
    id: "gitlab-oauth",
    name: "GitLab",
    description: "Projects, merge requests and issues on gitlab.com.",
    docs: "https://gitlab.com/-/user_settings/applications",
    api: "https://docs.gitlab.com/api/rest/",
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
      scopeDialect: "space",
      identity: {
        url: "https://gitlab.com/api/v4/user",
        label: "username",
        id: "id",
      },
    },
    scopeSets: {
      identity: {
        label: "GitLab account (who you are)",
        access: "read",
        scopes: ["read_user"],
      },
      "api.read": {
        label: "Projects, issues and merge requests (read)",
        access: "read",
        scopes: ["read_api"],
      },
      "api.write": {
        label: "Projects, issues and merge requests (read and write)",
        access: "write",
        scopes: ["api"],
      },
    },
    access: ["read", "write"],
    hint: "A self-managed GitLab needs a custom provider with its own host in place of gitlab.com.",
  },
  atlassian: {
    id: "atlassian",
    name: "Atlassian (Jira and Confluence)",
    description:
      "Jira issues and Confluence pages on the sites the person grants.",
    docs: "https://developer.atlassian.com/console/myapps/",
    api: "https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/",
    hosts: ["api.atlassian.com"],
    auth: {
      kind: "oauth2-user",
      authorizeUrl: "https://auth.atlassian.com/authorize",
      tokenUrl: "https://auth.atlassian.com/oauth/token",
      clientId: "ATLASSIAN_CLIENT_ID",
      clientSecret: "ATLASSIAN_CLIENT_SECRET",
      inject: "form",
      pkce: false,
      scopeDialect: "space",
      authorizeParams: { audience: "api.atlassian.com", prompt: "consent" },
      identity: {
        url: "https://api.atlassian.com/me",
        label: "email",
        id: "account_id",
      },
    },
    scopeSets: {
      identity: {
        label: "Atlassian account (who you are)",
        access: "read",
        scopes: ["read:me"],
      },
      "jira.read": {
        label: "Jira issues and projects (read)",
        access: "read",
        scopes: ["read:jira-work", "read:jira-user"],
      },
      "jira.write": {
        label: "Jira issues (read and write)",
        access: "write",
        scopes: ["read:jira-work", "write:jira-work"],
      },
      "confluence.read": {
        label: "Confluence pages (read)",
        access: "read",
        scopes: [
          "read:confluence-content.all",
          "read:confluence-space.summary",
        ],
      },
    },
    alwaysRequested: ["offline_access"],
    access: ["read", "write"],
    hint: "Calls go to api.atlassian.com/ex/jira/<cloud id>/… ; the cloud id comes from /oauth/token/accessible-resources.",
  },
  "hubspot-oauth": {
    id: "hubspot-oauth",
    name: "HubSpot",
    description: "CRM contacts, companies and deals.",
    docs: "https://developers.hubspot.com/",
    api: "https://developers.hubspot.com/docs/reference/api",
    hosts: ["api.hubapi.com"],
    auth: {
      kind: "oauth2-user",
      authorizeUrl: "https://app.hubspot.com/oauth/authorize",
      tokenUrl: "https://api.hubapi.com/oauth/v1/token",
      clientId: "HUBSPOT_OAUTH_CLIENT_ID",
      clientSecret: "HUBSPOT_OAUTH_CLIENT_SECRET",
      inject: "form",
      pkce: false,
      scopeDialect: "space",
    },
    scopeSets: {
      "contacts.read": {
        label: "Contacts (read)",
        access: "read",
        scopes: ["crm.objects.contacts.read"],
      },
      "contacts.write": {
        label: "Contacts (read and write)",
        access: "write",
        scopes: ["crm.objects.contacts.read", "crm.objects.contacts.write"],
      },
      "companies.read": {
        label: "Companies (read)",
        access: "read",
        scopes: ["crm.objects.companies.read"],
      },
      "deals.read": {
        label: "Deals (read)",
        access: "read",
        scopes: ["crm.objects.deals.read"],
      },
    },
    access: ["read", "write"],
    hint: "The app's scopes in HubSpot's developer console must match the sets apps declare, or HubSpot refuses the authorize URL.",
  },
  zoom: {
    id: "zoom",
    name: "Zoom",
    description: "The person's meetings and recordings.",
    docs: "https://marketplace.zoom.us/develop/create",
    api: "https://developers.zoom.us/docs/api/",
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
      scopeDialect: "space",
      identity: {
        url: "https://api.zoom.us/v2/users/me",
        label: "email",
        id: "id",
      },
    },
    scopeSets: {
      identity: {
        label: "Zoom account (who you are)",
        access: "read",
        scopes: ["user:read:user"],
      },
      "meetings.read": {
        label: "Meetings (read)",
        access: "read",
        scopes: ["meeting:read:meeting", "meeting:read:list_meetings"],
      },
      "meetings.write": {
        label: "Meetings (read, create and change)",
        access: "write",
        scopes: [
          "meeting:read:meeting",
          "meeting:write:meeting",
          "meeting:update:meeting",
        ],
      },
      "recordings.read": {
        label: "Cloud recordings (read)",
        access: "read",
        scopes: ["cloud_recording:read:list_user_recordings"],
      },
    },
    access: ["read", "write"],
    hint: "A General app with user-managed OAuth; Zoom's granular scope names are the ones listed here.",
  },
  dropbox: {
    id: "dropbox",
    name: "Dropbox",
    description: "Files and folders in the person's Dropbox.",
    docs: "https://www.dropbox.com/developers/apps",
    api: "https://www.dropbox.com/developers/documentation/http/documentation",
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
      scopeDialect: "space",
      authorizeParams: { token_access_type: "offline" },
    },
    // Dropbox is POST throughout, so each read set lists the read calls
    // it unlocks under `posts`; everything else needs the write set.
    scopeSets: {
      identity: {
        label: "Dropbox account (who you are)",
        access: "read",
        scopes: ["account_info.read"],
        routes: [
          {
            host: "api.dropboxapi.com",
            paths: [],
            posts: [
              "^/2/users/get_current_account$",
              "^/2/users/get_space_usage$",
            ],
          },
        ],
      },
      "files.read": {
        label: "Files and folders (read)",
        access: "read",
        scopes: ["files.metadata.read", "files.content.read"],
        routes: [
          {
            host: "api.dropboxapi.com",
            paths: [],
            posts: [
              "^/2/files/list_folder$",
              "^/2/files/list_folder/continue$",
              "^/2/files/get_metadata$",
              "^/2/files/search_v2$",
              "^/2/files/search/continue_v2$",
              "^/2/files/get_temporary_link$",
              "^/2/files/list_revisions$",
            ],
          },
          {
            host: "content.dropboxapi.com",
            paths: [],
            posts: [
              "^/2/files/download$",
              "^/2/files/get_thumbnail_v2$",
              "^/2/files/export$",
            ],
          },
        ],
      },
      "files.write": {
        label: "Files and folders (read and write)",
        access: "write",
        scopes: [
          "files.metadata.read",
          "files.content.read",
          "files.metadata.write",
          "files.content.write",
        ],
      },
    },
    access: ["read", "write"],
    hint: 'Dropbox\'s API is POST throughout: a read set unlocks its listed read calls, anything else needs access: "write". `token_access_type=offline` is what yields a refresh token.',
  },
  spotify: {
    id: "spotify",
    name: "Spotify",
    description: "The person's library, playlists and listening.",
    docs: "https://developer.spotify.com/dashboard",
    api: "https://developer.spotify.com/documentation/web-api",
    hosts: ["api.spotify.com"],
    auth: {
      kind: "oauth2-user",
      authorizeUrl: "https://accounts.spotify.com/authorize",
      tokenUrl: "https://accounts.spotify.com/api/token",
      clientId: "SPOTIFY_CLIENT_ID",
      clientSecret: "SPOTIFY_CLIENT_SECRET",
      inject: "basic",
      pkce: true,
      scopeDialect: "space",
      identity: {
        url: "https://api.spotify.com/v1/me",
        label: "display_name",
        id: "id",
      },
    },
    scopeSets: {
      identity: {
        label: "Spotify account (who you are)",
        access: "read",
        scopes: ["user-read-email", "user-read-private"],
      },
      "library.read": {
        label: "Saved tracks and albums (read)",
        access: "read",
        scopes: ["user-library-read"],
      },
      "playlists.read": {
        label: "Playlists (read)",
        access: "read",
        scopes: ["playlist-read-private", "playlist-read-collaborative"],
      },
      "playlists.write": {
        label: "Playlists (read and change)",
        access: "write",
        scopes: [
          "playlist-read-private",
          "playlist-modify-private",
          "playlist-modify-public",
        ],
      },
    },
    access: ["read", "write"],
  },
  "x-oauth": {
    id: "x-oauth",
    name: "X (OAuth 2)",
    description: "Posts and the person's profile on X, over the v2 API.",
    docs: "https://developer.x.com/en/portal/dashboard",
    api: "https://docs.x.com/x-api",
    hosts: ["api.x.com"],
    auth: {
      kind: "oauth2-user",
      authorizeUrl: "https://x.com/i/oauth2/authorize",
      tokenUrl: "https://api.x.com/2/oauth2/token",
      revokeUrl: "https://api.x.com/2/oauth2/revoke",
      clientId: "X_OAUTH_CLIENT_ID",
      clientSecret: "X_OAUTH_CLIENT_SECRET",
      inject: "basic",
      pkce: true,
      scopeDialect: "space",
      identity: {
        url: "https://api.x.com/2/users/me",
        label: "data.username",
        id: "data.id",
      },
    },
    scopeSets: {
      identity: {
        label: "X account (who you are)",
        access: "read",
        scopes: ["users.read", "tweet.read"],
      },
      "posts.read": {
        label: "Posts and timelines (read)",
        access: "read",
        scopes: ["tweet.read", "users.read"],
      },
      "posts.write": {
        label: "Posts (read and publish)",
        access: "write",
        scopes: ["tweet.read", "users.read", "tweet.write"],
      },
    },
    alwaysRequested: ["offline.access"],
    access: ["read", "write"],
    hint: "OAuth 2 with PKCE on X's v2 API; X's OAuth 1.0a (the v1.1 media upload) stays an app secret.",
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
