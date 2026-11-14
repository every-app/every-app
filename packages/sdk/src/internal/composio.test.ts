/**
 * The Composio map (./composio.ts): which providers Composio serves and
 * the services each one is there, which service owns a URL, which
 * services the scopes an app lists need, what a connection that holds
 * services lacks, and the one rule for how a provider is served and
 * whether it is set up. Each preset is read with its own flow's scope
 * rules.
 */
import { describe, expect, it } from "vitest";
import type { OAuthClientCapability, OAuthFlow } from "./capabilities";
import {
  ConnectionVia,
  composioMissingScopes,
  composioProviderIds,
  composioServes,
  composioServiceFor,
  composioServiceSlugs,
  composioServiceUrl,
  composioServicesNeeded,
  composioServicesOf,
  oauthProviderSetUp,
  oauthServing,
} from "./composio";
import { OAUTH_PRESETS, oauthPreset, oauthPresetIds } from "./oauthPresets";

function hostsOf(providerId: string): string[] {
  return OAUTH_PRESETS[providerId]!["hosts"] as string[];
}

function service(providerId: string, url: string): string | null {
  return composioServiceFor(providerId, new URL(url));
}

/** The scope rules of a preset's own flow. */
function flow(providerId: string): OAuthFlow {
  return (oauthPreset(providerId) as OAuthClientCapability).flow;
}

/** The services an app that lists `declared` needs, read with the preset's own rules. */
function needed(providerId: string, declared: string[]): string[] | null {
  return composioServicesNeeded(providerId, flow(providerId), declared);
}

/** What a connection with accounts for `services` lacks of `declared`. */
function missing(
  providerId: string,
  services: string[],
  declared: string[],
): string[] {
  return composioMissingScopes(
    providerId,
    flow(providerId),
    services,
    declared,
  );
}

const SINGLE = {
  "github-oauth": "github",
  slack: "slack",
  "notion-oauth": "notion",
  "linear-oauth": "linear",
  "gitlab-oauth": "gitlab",
  "hubspot-oauth": "hubspot",
  zoom: "zoom",
  dropbox: "dropbox",
} as const;

describe("the providers Composio serves", () => {
  it("are the presets of the table, and nothing else", () => {
    expect(composioProviderIds().sort()).toEqual(
      [
        ...Object.keys(SINGLE),
        "google-workspace",
        "microsoft-365",
        "atlassian",
      ].sort(),
    );
    for (const id of composioProviderIds()) {
      expect(oauthPresetIds()).toContain(id);
      expect(composioServes(id)).toBe(true);
    }
    for (const id of ["spotify", "openai", "my-own-spec", "toString"]) {
      expect(composioServes(id)).toBe(false);
      expect(composioServicesOf(id)).toEqual([]);
      expect(service(id, "https://api.spotify.com/v1/me")).toBeNull();
    }
  });

  it("name each provider's services, and every slug once for the account list", () => {
    expect(composioServicesOf("github-oauth")).toEqual([
      { slug: "github", label: "GitHub" },
    ]);
    expect(composioServicesOf("google-workspace")).toEqual([
      { slug: "gmail", label: "Gmail" },
      { slug: "googlecalendar", label: "Calendar" },
      { slug: "googledrive", label: "Drive" },
      { slug: "googlesheets", label: "Sheets" },
      { slug: "googledocs", label: "Docs" },
      { slug: "google_search_console", label: "Search Console" },
      { slug: "google_analytics", label: "Analytics" },
    ]);
    expect(composioServicesOf("microsoft-365")).toEqual([
      { slug: "outlook", label: "Outlook" },
      { slug: "one_drive", label: "OneDrive" },
      { slug: "microsoft_teams", label: "Teams" },
      { slug: "share_point", label: "SharePoint" },
    ]);
    expect(composioServicesOf("atlassian")).toEqual([
      { slug: "jira", label: "Jira" },
      { slug: "confluence", label: "Confluence" },
    ]);
    const slugs = composioServiceSlugs();
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs.sort()).toEqual(
      [
        ...Object.values(SINGLE),
        "gmail",
        "googlecalendar",
        "googledrive",
        "googlesheets",
        "googledocs",
        "google_search_console",
        "google_analytics",
        "outlook",
        "one_drive",
        "microsoft_teams",
        "share_point",
        "jira",
        "confluence",
      ].sort(),
    );
  });

  it("have a page per service in the person's own Composio", () => {
    expect(composioServiceUrl("google_search_console")).toBe(
      "https://dashboard.composio.dev/~/~/connect/apps/google_search_console",
    );
  });
});

describe("the service that owns a URL", () => {
  it("is the provider's one service on every host of a one-service preset, whatever the path", () => {
    for (const [providerId, slug] of Object.entries(SINGLE)) {
      for (const host of hostsOf(providerId)) {
        expect(service(providerId, `https://${host}/`)).toBe(slug);
        expect(service(providerId, `https://${host}/any/path?q=1`)).toBe(slug);
      }
      expect(service(providerId, "https://evil.example/")).toBeNull();
    }
  });

  it("is Google's by host, and by path on the host its services share", () => {
    const google = (url: string) => service("google-workspace", url);
    const owners: Record<string, [url: string, slug: string | null][]> = {
      "gmail.googleapis.com": [
        ["https://gmail.googleapis.com/gmail/v1/users/me/messages", "gmail"],
      ],
      "www.googleapis.com": [
        [
          "https://www.googleapis.com/calendar/v3/calendars/primary/events",
          "googlecalendar",
        ],
        ["https://www.googleapis.com/drive/v3/files?q=x", "googledrive"],
        [
          "https://www.googleapis.com/upload/drive/v3/files?uploadType=media",
          "googledrive",
        ],
        [
          "https://www.googleapis.com/webmasters/v3/sites",
          "google_search_console",
        ],
        // No rule: never guessed.
        ["https://www.googleapis.com/", null],
        ["https://www.googleapis.com/oauth2/v3/userinfo", null],
        ["https://www.googleapis.com/gmail/v1/users/me/profile", null],
        ["https://www.googleapis.com/calendarx/v3", null],
        ["https://www.googleapis.com/upload/gmail/v1/users/me/messages", null],
      ],
      "searchconsole.googleapis.com": [
        [
          "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect",
          "google_search_console",
        ],
      ],
      "analyticsdata.googleapis.com": [
        [
          "https://analyticsdata.googleapis.com/v1beta/properties/1:runReport",
          "google_analytics",
        ],
      ],
      "analyticsadmin.googleapis.com": [
        [
          "https://analyticsadmin.googleapis.com/v1beta/accountSummaries",
          "google_analytics",
        ],
      ],
      // The account's own identity: no service of Composio's owns it.
      "openidconnect.googleapis.com": [
        ["https://openidconnect.googleapis.com/v1/userinfo", null],
      ],
    };
    // Every host of the preset is decided here.
    expect(Object.keys(owners).sort()).toEqual(
      hostsOf("google-workspace").sort(),
    );
    for (const cases of Object.values(owners)) {
      for (const [url, slug] of cases)
        expect([url, google(url)]).toEqual([url, slug]);
    }
    // Hosts an operator's own spec may add.
    expect(google("https://sheets.googleapis.com/v4/spreadsheets/1")).toBe(
      "googlesheets",
    );
    expect(google("https://docs.googleapis.com/v1/documents/1")).toBe(
      "googledocs",
    );
    expect(google("https://people.googleapis.com/v1/people/me")).toBeNull();
  });

  it("is Microsoft's by path under Graph's version", () => {
    expect(hostsOf("microsoft-365")).toEqual(["graph.microsoft.com"]);
    const graph = (path: string) =>
      service("microsoft-365", `https://graph.microsoft.com${path}`);
    for (const [path, slug] of [
      ["/v1.0/me", "outlook"],
      ["/v1.0/me/messages?$top=5", "outlook"],
      ["/v1.0/me/mailFolders/inbox/messages", "outlook"],
      ["/v1.0/me/sendMail", "outlook"],
      ["/v1.0/me/events", "outlook"],
      ["/v1.0/me/calendar/events", "outlook"],
      ["/v1.0/me/calendars", "outlook"],
      ["/v1.0/me/calendarView?startDateTime=x", "outlook"],
      ["/v1.0/me/contacts", "outlook"],
      ["/beta/me/messages", "outlook"],
      ["/v1.0/me/drive/root/children", "one_drive"],
      ["/v1.0/me/drives", "one_drive"],
      ["/v1.0/drives/b!abc/items/1", "one_drive"],
      ["/v1.0/teams/1/channels", "microsoft_teams"],
      ["/v1.0/chats/1/messages", "microsoft_teams"],
      ["/v1.0/me/joinedTeams", "microsoft_teams"],
      ["/v1.0/sites/root", "share_point"],
      ["/v1.0/sites/contoso.sharepoint.com:/sites/hr", "share_point"],
      // No rule.
      ["/v1.0/me/todo/lists", null],
      ["/v1.0/users", null],
      ["/v1.0/me/drivex", null],
      ["/v1.0/mex", null],
      ["/v1.0", null],
      ["/", null],
      ["/v2.0/me", null],
    ] as const) {
      expect([path, graph(path)]).toEqual([path, slug]);
    }
    expect(
      service("microsoft-365", "https://outlook.office.com/me"),
    ).toBeNull();
  });

  it("is Atlassian's by the product in the path", () => {
    expect(hostsOf("atlassian")).toEqual(["api.atlassian.com"]);
    const atlassian = (path: string) =>
      service("atlassian", `https://api.atlassian.com${path}`);
    expect(atlassian("/ex/jira/cloud-1/rest/api/3/search?jql=x")).toBe("jira");
    expect(atlassian("/ex/confluence/cloud-1/wiki/api/v2/pages")).toBe(
      "confluence",
    );
    expect(atlassian("/oauth/token/accessible-resources")).toBeNull();
    expect(atlassian("/me")).toBeNull();
    expect(atlassian("/ex/jirax/cloud-1")).toBeNull();
    expect(atlassian("/ex/")).toBeNull();
  });
});

describe("the services an app's scopes need", () => {
  it("are the provider's one service for a one-service provider, whatever the app lists", () => {
    for (const [providerId, slug] of Object.entries(SINGLE)) {
      expect(needed(providerId, [])).toEqual([slug]);
      expect(needed(providerId, ["anything", "at:all"])).toEqual([slug]);
    }
  });

  it("are none Composio can name for a provider it doesn't serve", () => {
    expect(
      composioServicesNeeded("spotify", flow("spotify"), ["user-read-email"]),
    ).toBeNull();
  });

  it("are Google's by the scope, short or in full, in Google's own order, with none for a sign-in scope", () => {
    expect(needed("google-workspace", ["gmail.modify"])).toEqual(["gmail"]);
    expect(needed("google-workspace", ["calendar.events"])).toEqual([
      "googlecalendar",
    ]);
    expect(needed("google-workspace", ["webmasters.readonly"])).toEqual([
      "google_search_console",
    ]);
    // In the provider's order, each once, whatever order the app wrote.
    expect(
      needed("google-workspace", [
        "analytics.readonly",
        "https://www.googleapis.com/auth/calendar",
        "openid",
        "https://www.googleapis.com/auth/Gmail.Send",
        "gmail.readonly",
        "email",
        "https://mail.google.com/",
        "drive.file",
        "spreadsheets",
        "documents.readonly",
        "https://www.googleapis.com/auth/userinfo.email",
        "profile",
      ]),
    ).toEqual([
      "gmail",
      "googlecalendar",
      "googledrive",
      "googlesheets",
      "googledocs",
      "google_analytics",
    ]);
  });

  it("are null for Google when a scope belongs to no service, or the app lists sign-in scopes alone", () => {
    expect(needed("google-workspace", ["gmail.modify", "contacts"])).toBeNull();
    expect(needed("google-workspace", ["cloud-platform"])).toBeNull();
    // A name that only starts like a service's.
    expect(needed("google-workspace", ["calendarx"])).toBeNull();
    expect(needed("google-workspace", ["openid", "email"])).toBeNull();
    expect(needed("google-workspace", [])).toBeNull();
  });

  it("are Microsoft's by the scope, with none for User.Read and offline_access", () => {
    expect(needed("microsoft-365", ["Mail.Read"])).toEqual(["outlook"]);
    expect(needed("microsoft-365", ["Files.Read"])).toEqual(["one_drive"]);
    expect(
      needed("microsoft-365", [
        "Sites.Read.All",
        "offline_access",
        "https://graph.microsoft.com/Files.ReadWrite.All",
        "User.Read",
        "Calendars.ReadWrite",
        "ChannelMessage.Send",
        "openid",
      ]),
    ).toEqual(["outlook", "one_drive", "microsoft_teams", "share_point"]);
    expect(needed("microsoft-365", ["User.Read", "offline_access"])).toBeNull();
    expect(needed("microsoft-365", ["Mail.Read", "Tasks.Read"])).toBeNull();
  });

  it("are Atlassian's by the product a scope names", () => {
    expect(needed("atlassian", ["read:jira-work"])).toEqual(["jira"]);
    expect(needed("atlassian", ["read:confluence-content.all"])).toEqual([
      "confluence",
    ]);
    expect(
      needed("atlassian", [
        "write:confluence-content",
        "read:me",
        "read:jira-user",
        "offline_access",
      ]),
    ).toEqual(["jira", "confluence"]);
    expect(needed("atlassian", ["read:me", "offline_access"])).toBeNull();
    expect(needed("atlassian", ["read:jira-work", "read:account"])).toBeNull();
  });
});

describe("what a connection through Composio lacks", () => {
  it("is nothing for a one-service provider with its account, and every scope without it", () => {
    expect(missing("github-oauth", ["github"], ["repo", "workflow"])).toEqual(
      [],
    );
    expect(missing("github-oauth", [], ["repo", "workflow"])).toEqual([
      "repo",
      "workflow",
    ]);
    // Another provider's service is not this one's.
    expect(missing("github-oauth", ["gmail"], ["repo"])).toEqual(["repo"]);
  });

  it("is, for Google, the scopes whose service has no account and those no service covers, as the app wrote them; never a sign-in scope", () => {
    const declared = [
      "openid",
      "email",
      "gmail.modify",
      "https://www.googleapis.com/auth/calendar.events",
      "webmasters.readonly",
    ];
    expect(
      missing(
        "google-workspace",
        ["gmail", "googlecalendar", "google_search_console"],
        declared,
      ),
    ).toEqual([]);
    expect(missing("google-workspace", ["gmail"], declared)).toEqual([
      "https://www.googleapis.com/auth/calendar.events",
      "webmasters.readonly",
    ]);
    expect(missing("google-workspace", [], ["openid", "email"])).toEqual([]);
    // No service covers it: no connection through Composio holds it.
    expect(
      missing(
        "google-workspace",
        ["gmail", "googlecalendar"],
        ["gmail.modify", "contacts"],
      ),
    ).toEqual(["contacts"]);
  });

  it("is the same for Microsoft and Atlassian", () => {
    expect(
      missing(
        "microsoft-365",
        ["outlook"],
        ["User.Read", "offline_access", "Mail.Read", "Files.Read"],
      ),
    ).toEqual(["Files.Read"]);
    expect(
      missing(
        "atlassian",
        ["confluence"],
        ["read:me", "read:jira-work", "read:confluence-content.all"],
      ),
    ).toEqual(["read:jira-work"]);
  });

  it("is everything for a provider Composio doesn't serve", () => {
    expect(
      composioMissingScopes(
        "spotify",
        flow("spotify"),
        ["spotify"],
        ["user-read-email"],
      ),
    ).toEqual(["user-read-email"]);
  });
});

describe("how a provider is served, and whether it is set up", () => {
  const google = {
    providerId: "google-workspace",
    rules: flow("google-workspace"),
  };

  it("is with the Gateway's client whenever it holds one, whatever Composio would do", () => {
    for (const composioOn of [true, false]) {
      for (const providerId of ["google-workspace", "spotify"]) {
        expect(oauthServing({ providerId, clientHeld: true, composioOn })).toBe(
          ConnectionVia.OAuth,
        );
        expect(
          oauthProviderSetUp({
            providerId,
            rules: flow(providerId),
            // A scope no service of Composio's covers: the client is what serves it.
            declared: ["contacts"],
            clientHeld: true,
            composioOn,
          }),
        ).toBe(true);
      }
    }
  });

  it("is through Composio with no client, once the organization turned it on, for a provider it serves", () => {
    expect(
      oauthServing({
        providerId: "google-workspace",
        clientHeld: false,
        composioOn: true,
      }),
    ).toBe(ConnectionVia.Composio);
    expect(
      oauthServing({
        providerId: "github-oauth",
        clientHeld: false,
        composioOn: true,
      }),
    ).toBe(ConnectionVia.Composio);
  });

  it("is not at all with no client while Composio is off, or for a provider Composio doesn't serve", () => {
    expect(
      oauthServing({
        providerId: "google-workspace",
        clientHeld: false,
        composioOn: false,
      }),
    ).toBeNull();
    expect(
      oauthServing({
        providerId: "spotify",
        clientHeld: false,
        composioOn: true,
      }),
    ).toBeNull();
    expect(
      oauthProviderSetUp({
        ...google,
        declared: ["gmail.modify"],
        clientHeld: false,
        composioOn: false,
      }),
    ).toBe(false);
    expect(
      oauthProviderSetUp({
        providerId: "spotify",
        rules: flow("spotify"),
        declared: ["user-read-email"],
        clientHeld: false,
        composioOn: true,
      }),
    ).toBe(false);
  });

  it("is set up through Composio only when a service covers every scope the app lists", () => {
    const through = (providerId: string, declared: string[]) =>
      oauthProviderSetUp({
        providerId,
        rules: flow(providerId),
        declared,
        clientHeld: false,
        composioOn: true,
      });
    expect(through("google-workspace", ["openid", "gmail.modify"])).toBe(true);
    expect(through("google-workspace", ["gmail.modify", "contacts"])).toBe(
      false,
    );
    // Nothing that names one of Google's services.
    expect(through("google-workspace", ["openid", "email"])).toBe(false);
    expect(through("microsoft-365", ["User.Read", "Mail.Read"])).toBe(true);
    expect(through("microsoft-365", ["Tasks.Read"])).toBe(false);
    // One service: every scope is its own.
    expect(through("github-oauth", ["repo"])).toBe(true);
    expect(through("github-oauth", [])).toBe(true);
  });
});
