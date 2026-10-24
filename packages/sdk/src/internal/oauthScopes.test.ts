/**
 * The scope-set helpers the gateway's token-endpoint check and the proxy
 * boundary are built from: what a manifest declares, what that lets an app
 * ask for, how each provider spells what it granted, and which routes a set
 * unlocks. All three policies come from the registry: Google's and
 * Microsoft's, and Slack's with its bot and user tokens, a code exchange
 * without grant_type, and methods by name.
 */
import { describe, expect, it } from "vitest";
import { CAPABILITIES, type OAuthScopePolicy } from "./capabilities";
import type { TokenRequest } from "./oauthClient";
import {
  allowedScopes,
  carriesToken,
  declaredScopeSets,
  grantedScopes,
  requestedScopes,
  requestedTokenScopes,
  rewriteTokenRequestScope,
  scopeExcess,
  scopeRouteAllows,
} from "./oauthScopes";

const GOOGLE = CAPABILITIES["google-workspace"].scopePolicy;
const MICROSOFT = CAPABILITIES["microsoft-365"].scopePolicy;
const GOOGLE_SETS = Object.keys(GOOGLE.sets);
const MICROSOFT_SETS = Object.keys(MICROSOFT.sets);

const GMAIL = "https://www.googleapis.com/auth/gmail.readonly";
const CALENDAR = "https://www.googleapis.com/auth/calendar.readonly";
const WEBMASTERS = "https://www.googleapis.com/auth/webmasters.readonly";
const EMAIL = "https://www.googleapis.com/auth/userinfo.email";
const PROFILE = "https://www.googleapis.com/auth/userinfo.profile";

const SLACK = CAPABILITIES.slack.scopePolicy;
/** What Postiz's and Open CRM's manifests list for `slack` once they redeploy with `scopes`. */
const POSTIZ_SLACK = [
  "channels.read",
  "users.read",
  "messages.write",
  "channels.join",
  "files.write",
];
const OPEN_CRM_SLACK = [
  "channels.read",
  "users.read",
  "users.email",
  "messages.write",
  "channels.join",
  "channels.manage",
  "user-channels.manage",
];
const OPEN_CRM_USER_SCOPES = [
  "channels:read",
  "channels:write",
  "groups:read",
  "groups:write",
];

const FORM = "application/x-www-form-urlencoded";
const JSON_TYPE = "application/json";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const MS_TOKEN = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const SLACK_TOKEN = "https://slack.com/api/oauth.v2.access";

function request(
  url: string,
  body: string | null,
  type?: string,
): TokenRequest {
  return {
    url: new URL(url),
    headers: new Headers(type ? { "content-type": type } : {}),
    body,
  };
}

describe("declaredScopeSets", () => {
  it("keeps a valid list as the manifest declared it", () => {
    expect(
      declaredScopeSets(GOOGLE, { scopes: ["calendar.read", "gmail.read"] }),
    ).toEqual(["calendar.read", "gmail.read"]);
    expect(
      declaredScopeSets(MICROSOFT, { scopes: ["identity", "mail.read"] }),
    ).toEqual(["identity", "mail.read"]);
  });

  it.each<[string, { scopes?: unknown } | undefined]>([
    ["no entry", undefined],
    ["no scopes", {}],
    ["an empty list", { scopes: [] }],
    ["a string instead of a list", { scopes: "gmail.read" }],
    ["an object instead of a list", { scopes: { "gmail.read": true } }],
    ["a non-string element", { scopes: ["gmail.read", 1] }],
    ["a set listed twice", { scopes: ["gmail.read", "gmail.read"] }],
    // A partial grant is a grant nobody declared.
    [
      "an unknown set among known ones",
      { scopes: ["gmail.read", "gmail.write"] },
    ],
    ["another client's set", { scopes: ["mail.read"] }],
    ["an inherited property", { scopes: ["constructor"] }],
    ["another inherited property", { scopes: ["toString"] }],
  ])("voids the whole grant for %s", (_name, entry) => {
    expect(declaredScopeSets(GOOGLE, entry)).toBeNull();
  });
});

describe("requestedScopes", () => {
  it("lists the sets' scopes in registry order, once each, whatever order the manifest used", () => {
    expect(
      requestedScopes(GOOGLE, ["search-console.read", "identity"]),
    ).toEqual({
      scopes: ["openid", "email", "profile", WEBMASTERS],
      userScopes: [],
    });
  });

  it("adds offline_access for Microsoft only, after the sets' scopes", () => {
    expect(
      requestedScopes(MICROSOFT, ["identity", "mail.read"]).scopes,
    ).toEqual(["User.Read", "Mail.Read", "offline_access"]);
    expect(requestedScopes(GOOGLE, ["gmail.read"]).scopes).toEqual([GMAIL]);
  });

  it("keeps Slack's user scopes apart from the bot's, the same name on both sides included", () => {
    expect(
      requestedScopes(SLACK, ["channels.read", "user-channels.manage"]),
    ).toEqual({
      scopes: ["channels:read", "groups:read"],
      userScopes: OPEN_CRM_USER_SCOPES,
    });
  });
});

describe("allowedScopes", () => {
  it("adds the tolerated identity scopes, spelled as Google echoes them", () => {
    expect(allowedScopes(GOOGLE, ["gmail.read"]).scopes).toEqual([
      GMAIL,
      "openid",
      EMAIL,
      PROFILE,
    ]);
  });

  it("lowercases Microsoft's, as its answers come in either case", () => {
    expect(allowedScopes(MICROSOFT, ["mail.read"]).scopes).toEqual([
      "mail.read",
      "offline_access",
      "openid",
      "profile",
      "email",
      "user.read",
    ]);
  });
});

describe("grantedScopes", () => {
  it("google: splits on whitespace and aliases email and profile to the userinfo URLs", () => {
    expect(
      grantedScopes(GOOGLE, {
        access_token: "t",
        scope: `openid email ${GMAIL}  profile`,
      }),
    ).toEqual({ scopes: ["openid", EMAIL, GMAIL, PROFILE] });
  });

  it.each<[string, unknown]>([
    ["no scope", { access_token: "t" }],
    ["a scope that isn't a string", { access_token: "t", scope: [GMAIL] }],
    ["an empty scope", { access_token: "t", scope: " " }],
    ["a body that isn't an object", "t"],
  ])("google: %s is unverified", (_name, json) => {
    expect(grantedScopes(GOOGLE, json)).toBeNull();
  });

  it.each([
    [
      "URL-encoded with the Graph prefix, as documented",
      "https%3A%2F%2Fgraph.microsoft.com%2Fmail.read",
    ],
    ["the Graph prefix in clear", "https://graph.microsoft.com/Mail.Read"],
    ["a short name in Microsoft's case", "Mail.Read"],
    ["a short name in lower case", "mail.read"],
  ])("microsoft: %s reads as mail.read", (_name, scope) => {
    expect(grantedScopes(MICROSOFT, { access_token: "t", scope })).toEqual({
      scopes: ["mail.read"],
    });
  });

  it("microsoft: drops offline_access, which Entra never echoes, and keeps the rest", () => {
    expect(
      grantedScopes(MICROSOFT, {
        access_token: "t",
        scope: "User.Read Mail.Read offline_access openid",
      }),
    ).toEqual({ scopes: ["user.read", "mail.read", "openid"] });
  });

  it.each<[string, unknown]>([
    ["no scope", { access_token: "t", refresh_token: "r" }],
    ["malformed encoding", { access_token: "t", scope: "Mail.Read%" }],
    ["only offline_access", { access_token: "t", scope: "offline_access" }],
    ["an empty scope", { access_token: "t", scope: "" }],
  ])("microsoft: %s is unverified", (_name, json) => {
    expect(grantedScopes(MICROSOFT, json)).toBeNull();
  });

  it("slack: the bot token's scopes at the top level, the person's under authed_user", () => {
    expect(
      grantedScopes(SLACK, {
        ok: true,
        access_token: "xoxb-1",
        token_type: "bot",
        scope: "channels:read,groups:read",
        authed_user: {
          id: "U1",
          access_token: "xoxp-1",
          token_type: "user",
          scope: "channels:write",
        },
      }),
    ).toEqual({
      scopes: ["channels:read", "groups:read"],
      userScopes: ["channels:write"],
    });
  });

  it("slack: authed_user is the person's token unless it says otherwise", () => {
    expect(
      grantedScopes(SLACK, {
        ok: true,
        authed_user: {
          access_token: "xoxp-1",
          scope: "channels:write,groups:write",
        },
      }),
    ).toEqual({ userScopes: ["channels:write", "groups:write"] });
  });

  it("slack: a rotation refresh of a user token comes back at the top level as one", () => {
    expect(
      grantedScopes(SLACK, {
        ok: true,
        access_token: "xoxe.xoxp-1",
        token_type: "user",
        scope: "channels:write groups:write",
        refresh_token: "xoxe-1",
      }),
    ).toEqual({ userScopes: ["channels:write", "groups:write"] });
  });

  it("slack: an installation that asked nothing for the person carries bot scopes only", () => {
    expect(
      grantedScopes(SLACK, {
        ok: true,
        access_token: "xoxb-1",
        token_type: "bot",
        scope: "chat:write",
        authed_user: { id: "U1" },
      }),
    ).toEqual({ scopes: ["chat:write"] });
  });

  it.each<[string, unknown]>([
    [
      "a token without token_type",
      { access_token: "xoxb-1", scope: "chat:write" },
    ],
    [
      "a token of an unknown kind",
      { access_token: "xoxb-1", token_type: "app", scope: "chat:write" },
    ],
    [
      "a bot token without scopes",
      { access_token: "xoxb-1", token_type: "bot" },
    ],
    [
      "a user token without scopes",
      { authed_user: { access_token: "xoxp-1" } },
    ],
    ["neither token", { ok: true, team: { id: "T1" } }],
  ])("slack: %s is unverified", (_name, json) => {
    expect(grantedScopes(SLACK, json)).toBeNull();
  });
});

describe("carriesToken", () => {
  it.each<[string, unknown]>([
    ["an access token", { access_token: "t" }],
    ["a refresh token alone", { refresh_token: "r" }],
    ["an ID token alone", { id_token: "i" }],
    ["Slack's user token", { authed_user: { access_token: "xoxp-1" } }],
  ])("sees %s", (_name, json) => {
    expect(carriesToken(json)).toBe(true);
  });

  it.each<[string, unknown]>([
    ["Slack's ok:false", { ok: false, error: "invalid_code" }],
    ["a token that isn't a string", { access_token: 1 }],
    ["an empty authed_user", { ok: true, authed_user: {} }],
    ["an array", []],
    ["a string", "t"],
    ["null", null],
  ])("sees no token in %s", (_name, json) => {
    expect(carriesToken(json)).toBe(false);
  });
});

describe("scopeExcess", () => {
  it("is empty within the grant, tolerated identity included", () => {
    expect(
      scopeExcess(
        { scopes: [GMAIL, "openid", EMAIL] },
        allowedScopes(GOOGLE, ["gmail.read"]),
      ),
    ).toEqual([]);
  });

  it("lists what the grant doesn't cover", () => {
    expect(
      scopeExcess(
        { scopes: [WEBMASTERS, GMAIL, CALENDAR] },
        allowedScopes(GOOGLE, ["search-console.read"]),
      ),
    ).toEqual([GMAIL, CALENDAR]);
  });

  it("holds a user token to the user scopes only, naming its extras as user:", () => {
    expect(
      scopeExcess(
        { scopes: ["channels:read"], userScopes: ["channels:read"] },
        allowedScopes(SLACK, ["channels.read"]),
      ),
    ).toEqual(["user:channels:read"]);
    expect(
      scopeExcess(
        { userScopes: ["channels:write"] },
        allowedScopes(SLACK, ["user-channels.manage"]),
      ),
    ).toEqual([]);
  });
});

describe("slack: the registry's policy against its consumers' token answers", () => {
  /** `oauth.v2.access` as Slack answers an install: the bot token, and the installer's when `user_scope` was asked. */
  const install = (scope: string, userScope?: string) => ({
    ok: true,
    access_token: "xoxb-1",
    token_type: "bot",
    scope,
    bot_user_id: "B1",
    team: { id: "T1", name: "Acme" },
    authed_user:
      userScope === undefined
        ? { id: "U1" }
        : {
            id: "U1",
            access_token: "xoxp-1",
            token_type: "user",
            scope: userScope,
          },
  });
  const excess = (json: unknown, sets: string[]) => {
    const granted = grantedScopes(SLACK, json);
    expect(granted).not.toBeNull();
    return scopeExcess(granted!, allowedScopes(SLACK, sets));
  };

  it("passes a bot token within the declared sets", () => {
    const postiz = install(
      "channels:read,chat:write,users:read,groups:read,channels:join,chat:write.customize,files:write",
    );
    expect(excess(postiz, POSTIZ_SLACK)).toEqual([]);
    // Postiz's sets, minus the one that unlocks uploads.
    expect(excess(postiz, POSTIZ_SLACK.slice(0, -1))).toEqual(["files:write"]);
    // Nothing is tolerated on Slack: a history scope is excess however common.
    expect(
      excess(
        install("channels:read,groups:read,channels:history"),
        POSTIZ_SLACK,
      ),
    ).toEqual(["channels:history"]);
  });

  it("reports the installer's scopes outside user-channels.manage as user:, while the bot token passes", () => {
    const openCrm = install(
      "users:read,users:read.email,channels:read,groups:read,chat:write,chat:write.public,im:write,channels:join,channels:manage,groups:write,channels:write.invites,groups:write.invites",
      "channels:read,channels:write,groups:read,groups:write",
    );
    expect(excess(openCrm, OPEN_CRM_SLACK)).toEqual([]);
    const wider = install(
      "users:read,channels:read,groups:read,chat:write",
      "channels:read,channels:write,groups:read,groups:write,chat:write",
    );
    expect(excess(wider, OPEN_CRM_SLACK)).toEqual(["user:chat:write"]);
    // Without the user set declared, every installer scope is excess, and
    // the bot's `channels:read` doesn't cover the person's.
    expect(
      excess(
        wider,
        OPEN_CRM_SLACK.filter((name) => name !== "user-channels.manage"),
      ),
    ).toEqual([
      "user:channels:read",
      "user:channels:write",
      "user:groups:read",
      "user:groups:write",
      "user:chat:write",
    ]);
  });

  it("checks a user-only answer on authed_user alone", () => {
    const userOnly = {
      ok: true,
      team: { id: "T1" },
      authed_user: {
        id: "U1",
        access_token: "xoxp-1",
        scope: "channels:read,channels:write,groups:read,groups:write",
      },
    };
    expect(grantedScopes(SLACK, userOnly)).toEqual({
      userScopes: OPEN_CRM_USER_SCOPES,
    });
    expect(excess(userOnly, ["user-channels.manage"])).toEqual([]);
    expect(excess(userOnly, ["channels.read"])).toEqual(
      OPEN_CRM_USER_SCOPES.map((scope) => `user:${scope}`),
    );
  });

  it("holds a rotation refresh to the scopes of the token's kind", () => {
    const user = {
      ok: true,
      access_token: "xoxe.xoxp-1",
      token_type: "user",
      scope: "channels:read,channels:write,groups:read,groups:write",
      refresh_token: "xoxe-1-user",
      expires_in: 43200,
    };
    expect(grantedScopes(SLACK, user)).toEqual({
      userScopes: OPEN_CRM_USER_SCOPES,
    });
    expect(excess(user, ["user-channels.manage"])).toEqual([]);
    expect(excess(user, ["channels.read", "channels.manage"])).toEqual(
      OPEN_CRM_USER_SCOPES.map((scope) => `user:${scope}`),
    );
    const bot = { ...user, access_token: "xoxe.xoxb-1", token_type: "bot" };
    expect(excess(bot, ["channels.read", "channels.manage"])).toEqual([
      "channels:write",
    ]);
    // A refresh answer that doesn't say which kind it is can't be held to either.
    const { token_type: _kind, ...unsaid } = user;
    expect(grantedScopes(SLACK, unsaid)).toBeNull();
  });
});

describe("requestedTokenScopes", () => {
  it("reads scope from a form body, canonicalised like an answer", () => {
    expect(
      requestedTokenScopes(
        MICROSOFT,
        request(
          MS_TOKEN,
          "grant_type=refresh_token&refresh_token=r&scope=https%3A%2F%2Fgraph.microsoft.com%2FMail.Send%20offline_access",
          FORM,
        ),
      ),
    ).toEqual({ scopes: ["mail.send", "offline_access"] });
  });

  it("reads scope and user_scope from a JSON body", () => {
    expect(
      requestedTokenScopes(
        SLACK,
        request(
          SLACK_TOKEN,
          JSON.stringify({
            code: "c",
            scope: "chat:write,channels:read",
            user_scope: "channels:write",
          }),
          JSON_TYPE,
        ),
      ),
    ).toEqual({
      scopes: ["chat:write", "channels:read"],
      userScopes: ["channels:write"],
    });
  });

  it("joins a field sent twice, so nothing hides in the second copy", () => {
    expect(
      requestedTokenScopes(
        MICROSOFT,
        request(MS_TOKEN, "scope=Mail.Read&code=c&scope=Mail.Send", FORM),
      ),
    ).toEqual({ scopes: ["mail.read", "mail.send"] });
  });

  it("joins Scope and scope, which Entra reads as one name", () => {
    expect(
      requestedTokenScopes(
        MICROSOFT,
        request(MS_TOKEN, "Scope=Mail.Read&code=c&scope=Mail.Send", FORM),
      ),
    ).toEqual({ scopes: ["mail.read", "mail.send"] });
    expect(
      requestedTokenScopes(
        MICROSOFT,
        request(
          MS_TOKEN,
          JSON.stringify({ Scope: "Mail.Read", code: "c", scope: "Mail.Send" }),
          JSON_TYPE,
        ),
      ),
    ).toEqual({ scopes: ["mail.read", "mail.send"] });
  });

  it.each<[string, TokenRequest]>([
    [
      "a form",
      request(MS_TOKEN, "grant_type=refresh_token&SCOPE=Mail.Send", FORM),
    ],
    [
      "a JSON body",
      request(
        MS_TOKEN,
        JSON.stringify({ code: "c", Scope: "Mail.Send" }),
        JSON_TYPE,
      ),
    ],
  ])("reads the field in any case from %s", (_name, sent) => {
    expect(requestedTokenScopes(MICROSOFT, sent)).toEqual({
      scopes: ["mail.send"],
    });
  });

  it("never reads the query string", () => {
    expect(
      requestedTokenScopes(
        GOOGLE,
        request(
          `${GOOGLE_TOKEN}?scope=${encodeURIComponent(GMAIL)}`,
          "grant_type=authorization_code&code=c",
          FORM,
        ),
      ),
    ).toBeNull();
  });

  it.each<[string, TokenRequest]>([
    ["no body", request(GOOGLE_TOKEN, null)],
    [
      "a body without a scope",
      request(GOOGLE_TOKEN, "grant_type=refresh_token&refresh_token=r", FORM),
    ],
    ["an empty scope", request(GOOGLE_TOKEN, "scope=&code=c", FORM)],
    [
      "a body it can't read",
      request(GOOGLE_TOKEN, `scope=${GMAIL}`, "text/plain"),
    ],
    [
      "a JSON scope that isn't a string",
      request(
        SLACK_TOKEN,
        JSON.stringify({ scope: ["chat:write"] }),
        JSON_TYPE,
      ),
    ],
    [
      "a JSON scope spelled twice, once not a string",
      request(
        SLACK_TOKEN,
        JSON.stringify({ Scope: ["chat:write"], scope: "chat:read" }),
        JSON_TYPE,
      ),
    ],
  ])("names none for %s", (_name, sent) => {
    expect(requestedTokenScopes(GOOGLE, sent)).toBeNull();
  });
});

describe("rewriteTokenRequestScope", () => {
  it("replace: sets Microsoft's token-leg scope to the app's list over whatever it sent", () => {
    const out = rewriteTokenRequestScope(
      MICROSOFT,
      ["identity", "mail.read"],
      request(
        MS_TOKEN,
        "grant_type=authorization_code&code=c&scope=Mail.Send&client_id=gw",
        FORM,
      ),
    );
    const params = new URLSearchParams(out.body!);
    expect(params.getAll("scope")).toEqual([
      "User.Read Mail.Read offline_access",
    ]);
    expect(params.get("code")).toBe("c");
    expect(params.get("client_id")).toBe("gw");
  });

  it("replace: adds the scope when the app sent none", () => {
    const out = rewriteTokenRequestScope(
      MICROSOFT,
      ["mail.read"],
      request(MS_TOKEN, "grant_type=refresh_token&refresh_token=r", FORM),
    );
    expect(new URLSearchParams(out.body!).get("scope")).toBe(
      "Mail.Read offline_access",
    );
  });

  it("drop: removes Google's and leaves the rest", () => {
    const out = rewriteTokenRequestScope(
      GOOGLE,
      ["gmail.read"],
      request(
        GOOGLE_TOKEN,
        `grant_type=authorization_code&code=c&scope=${encodeURIComponent(GMAIL)}&redirect_uri=https%3A%2F%2Fcrm.example.com%2Fcb`,
        FORM,
      ),
    );
    const params = new URLSearchParams(out.body!);
    expect(params.has("scope")).toBe(false);
    expect(params.get("code")).toBe("c");
    expect(params.get("redirect_uri")).toBe("https://crm.example.com/cb");
  });

  it("drop: edits a JSON body the same way", () => {
    const out = rewriteTokenRequestScope(
      GOOGLE,
      ["gmail.read"],
      request(
        GOOGLE_TOKEN,
        JSON.stringify({ code: "c", scope: GMAIL }),
        JSON_TYPE,
      ),
    );
    expect(JSON.parse(out.body!)).toEqual({ code: "c" });
  });

  it("replace: edits a JSON body the same way", () => {
    const out = rewriteTokenRequestScope(
      MICROSOFT,
      ["mail.read"],
      request(
        MS_TOKEN,
        JSON.stringify({ code: "c", scope: "Mail.Send" }),
        JSON_TYPE,
      ),
    );
    expect(JSON.parse(out.body!)).toEqual({
      code: "c",
      scope: "Mail.Read offline_access",
    });
  });

  // Entra reads a form's names in any case: a `Scope` left beside the
  // gateway's `scope` is refused upstream as a duplicate, or read instead.
  it("removes the app's scope in any case, as the client credentials are", () => {
    const form = rewriteTokenRequestScope(
      MICROSOFT,
      ["mail.read"],
      request(
        MS_TOKEN,
        "grant_type=refresh_token&refresh_token=r&Scope=Mail.Send&SCOPE=Calendars.Read",
        FORM,
      ),
    );
    const params = new URLSearchParams(form.body!);
    expect(
      [...params.keys()].filter((name) => name.toLowerCase() === "scope"),
    ).toEqual(["scope"]);
    expect(params.get("scope")).toBe("Mail.Read offline_access");
    expect(params.get("refresh_token")).toBe("r");
    const json = rewriteTokenRequestScope(
      MICROSOFT,
      ["mail.read"],
      request(
        MS_TOKEN,
        JSON.stringify({ code: "c", Scope: "Mail.Send", scope: "Mail.Send" }),
        JSON_TYPE,
      ),
    );
    expect(JSON.parse(json.body!)).toEqual({
      code: "c",
      scope: "Mail.Read offline_access",
    });
    const dropped = rewriteTokenRequestScope(
      GOOGLE,
      ["gmail.read"],
      request(GOOGLE_TOKEN, `code=c&Scope=${encodeURIComponent(GMAIL)}`, FORM),
    );
    expect(dropped.body).toBe("code=c");
  });

  it("keep: returns Slack's request as sent", () => {
    const sent = request(SLACK_TOKEN, "code=c", FORM);
    expect(rewriteTokenRequestScope(SLACK, ["channels.read"], sent)).toBe(sent);
  });

  it("leaves a body it can't read alone", () => {
    const sent = request(GOOGLE_TOKEN, "code=c", "text/plain");
    expect(rewriteTokenRequestScope(GOOGLE, ["gmail.read"], sent)).toBe(sent);
    const empty = request(GOOGLE_TOKEN, null);
    expect(rewriteTokenRequestScope(GOOGLE, ["gmail.read"], empty)).toBe(empty);
  });

  it("leaves a JSON body it can't parse alone", () => {
    const sent = request(MS_TOKEN, "{not json", JSON_TYPE);
    expect(rewriteTokenRequestScope(MICROSOFT, ["mail.read"], sent)).toBe(sent);
  });

  it("leaves a JSON array alone", () => {
    const sent = request(MS_TOKEN, "[1]", JSON_TYPE);
    expect(rewriteTokenRequestScope(MICROSOFT, ["mail.read"], sent)).toBe(sent);
  });
});

describe("scopeRouteAllows", () => {
  const allows = (
    policy: OAuthScopePolicy,
    sets: readonly string[],
    method: string,
    url: string,
  ) => scopeRouteAllows(policy, sets, method, new URL(url));

  /** Every route of the Google tables, one representative call each. */
  const GOOGLE_COVERED: [string, string, string][] = [
    ["GET", "https://openidconnect.googleapis.com/v1/userinfo", "identity"],
    ["GET", "https://www.googleapis.com/oauth2/v2/userinfo", "identity"],
    ["GET", "https://www.googleapis.com/oauth2/v3/userinfo", "identity"],
    ["GET", "https://www.googleapis.com/userinfo/v2/me", "identity"],
    [
      "GET",
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10",
      "gmail.read",
    ],
    [
      "GET",
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/18c/attachments/ANGjdJ8",
      "gmail.read",
    ],
    [
      "HEAD",
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      "gmail.read",
    ],
    [
      "POST",
      "https://gmail.googleapis.com/gmail/v1/users/me/watch",
      "gmail.read",
    ],
    [
      "POST",
      "https://gmail.googleapis.com/gmail/v1/users/me/stop",
      "gmail.read",
    ],
    [
      "GET",
      "https://www.googleapis.com/calendar/v3/users/me/calendarList",
      "calendar.read",
    ],
    [
      "GET",
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      "calendar.read",
    ],
    [
      "POST",
      "https://www.googleapis.com/calendar/v3/freeBusy",
      "calendar.read",
    ],
    [
      "POST",
      "https://www.googleapis.com/calendar/v3/calendars/primary/events/watch",
      "calendar.read",
    ],
    [
      "POST",
      "https://www.googleapis.com/calendar/v3/users/me/calendarList/watch",
      "calendar.read",
    ],
    [
      "POST",
      "https://www.googleapis.com/calendar/v3/channels/stop",
      "calendar.read",
    ],
    [
      "GET",
      "https://www.googleapis.com/webmasters/v3/sites",
      "search-console.read",
    ],
    // A site is one segment, URL-encoded or a domain property. A URL-prefix
    // property's own path may hold a denied word or an encoded character:
    // the encoded slash is part of the one id to Google, not a separator.
    [
      "POST",
      "https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.com%2F/searchAnalytics/query",
      "search-console.read",
    ],
    [
      "POST",
      "https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.com%2Fbatch%2F/searchAnalytics/query",
      "search-console.read",
    ],
    [
      "GET",
      "https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.com%2Fcaf%25C3%25A9%2F/sitemaps",
      "search-console.read",
    ],
    [
      "GET",
      "https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/sitemaps",
      "search-console.read",
    ],
    [
      "POST",
      "https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query",
      "search-console.read",
    ],
    [
      "POST",
      "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect",
      "search-console.read",
    ],
    [
      "POST",
      "https://analyticsdata.googleapis.com/v1beta/properties/123:runReport",
      "analytics.read",
    ],
    [
      "POST",
      "https://analyticsdata.googleapis.com/v1beta/properties/123:batchRunReports",
      "analytics.read",
    ],
    [
      "POST",
      "https://analyticsdata.googleapis.com/v1beta/properties/123:runPivotReport",
      "analytics.read",
    ],
    [
      "POST",
      "https://analyticsdata.googleapis.com/v1beta/properties/123:batchRunPivotReports",
      "analytics.read",
    ],
    [
      "POST",
      "https://analyticsdata.googleapis.com/v1beta/properties/123:runRealtimeReport",
      "analytics.read",
    ],
    [
      "POST",
      "https://analyticsdata.googleapis.com/v1beta/properties/123:checkCompatibility",
      "analytics.read",
    ],
    [
      "GET",
      "https://analyticsdata.googleapis.com/v1beta/properties/123/metadata",
      "analytics.read",
    ],
    [
      "GET",
      "https://analyticsadmin.googleapis.com/v1beta/accountSummaries",
      "analytics.read",
    ],
    [
      "GET",
      "https://analyticsadmin.googleapis.com/v1beta/accounts",
      "analytics.read",
    ],
    [
      "GET",
      "https://analyticsadmin.googleapis.com/v1beta/accounts/1",
      "analytics.read",
    ],
    [
      "GET",
      "https://analyticsadmin.googleapis.com/v1beta/properties?filter=parent:accounts/1",
      "analytics.read",
    ],
    [
      "GET",
      "https://analyticsadmin.googleapis.com/v1beta/properties/123/dataStreams",
      "analytics.read",
    ],
    [
      "GET",
      "https://analyticsadmin.googleapis.com/v1beta/properties/123/keyEvents",
      "analytics.read",
    ],
    [
      "GET",
      "https://analyticsadmin.googleapis.com/v1alpha/properties/123/dataStreams/4/enhancedMeasurementSettings",
      "analytics.read",
    ],
  ];

  /** Every route of the Microsoft table. */
  const MICROSOFT_COVERED: [string, string, string][] = [
    ["GET", "https://graph.microsoft.com/v1.0/me", "identity"],
    ["GET", "https://graph.microsoft.com/oidc/userinfo", "identity"],
    [
      "GET",
      "https://graph.microsoft.com/v1.0/me/messages?$top=10",
      "mail.read",
    ],
    [
      "GET",
      "https://graph.microsoft.com/v1.0/me/messages/AAMk/attachments",
      "mail.read",
    ],
    ["GET", "https://graph.microsoft.com/v1.0/me/messages/delta", "mail.read"],
    ["GET", "https://graph.microsoft.com/v1.0/me/mailFolders", "mail.read"],
    [
      "GET",
      "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages",
      "mail.read",
    ],
    ["GET", "https://graph.microsoft.com/v1.0/me/calendar", "calendar.read"],
    [
      "GET",
      "https://graph.microsoft.com/v1.0/me/calendar/events",
      "calendar.read",
    ],
    ["GET", "https://graph.microsoft.com/v1.0/me/calendars", "calendar.read"],
    [
      "GET",
      "https://graph.microsoft.com/v1.0/me/calendars/AAMk/calendarView?startDateTime=a&endDateTime=b",
      "calendar.read",
    ],
    ["GET", "https://graph.microsoft.com/v1.0/me/events", "calendar.read"],
    [
      "GET",
      "https://graph.microsoft.com/v1.0/me/events/AAMk/instances",
      "calendar.read",
    ],
    [
      "GET",
      "https://graph.microsoft.com/v1.0/me/calendarView",
      "calendar.read",
    ],
    [
      "GET",
      "https://graph.microsoft.com/v1.0/me/calendarView/delta",
      "calendar.read",
    ],
    [
      "POST",
      "https://graph.microsoft.com/v1.0/me/calendar/getSchedule",
      "calendar.read",
    ],
  ];

  const covered = (
    policy: OAuthScopePolicy,
    all: string[],
    method: string,
    url: string,
    set: string,
  ) => {
    expect(allows(policy, all, method, url)).toBe(set);
    expect(allows(policy, [set], method, url)).toBe(set);
    for (const other of all.filter((name) => name !== set)) {
      expect(allows(policy, [other], method, url), other).toBeNull();
    }
    // Nothing declared covers nothing; no write method goes through.
    expect(allows(policy, [], method, url)).toBeNull();
    for (const verb of ["PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect(allows(policy, all, verb, url), verb).toBeNull();
    }
  };

  it.each(GOOGLE_COVERED)(
    "%s %s is covered by %s and by no other Google set",
    (method, url, set) => covered(GOOGLE, GOOGLE_SETS, method, url, set),
  );

  it.each(MICROSOFT_COVERED)(
    "%s %s is covered by %s and by no other Microsoft set",
    (method, url, set) => covered(MICROSOFT, MICROSOFT_SETS, method, url, set),
  );

  it.each([
    // Writes under a read prefix.
    ["POST", "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"],
    ["POST", "https://gmail.googleapis.com/gmail/v1/users/me/drafts"],
    ["POST", "https://gmail.googleapis.com/gmail/v1/users/me/drafts/send"],
    [
      "POST",
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/18c/modify",
    ],
    [
      "POST",
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/18c/trash",
    ],
    ["POST", "https://www.googleapis.com/calendar/v3/calendars/primary/events"],
    [
      "POST",
      "https://www.googleapis.com/calendar/v3/calendars/primary/events/quickAdd",
    ],
    [
      "PUT",
      "https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.com%2F/sitemaps/https%3A%2F%2Fexample.com%2Fsitemap.xml",
    ],
    ["POST", "https://analyticsadmin.googleapis.com/v1beta/properties"],
    [
      "POST",
      "https://analyticsadmin.googleapis.com/v1beta/properties/123:runAccessReport",
    ],
    // Batch tunnels, however spelled.
    ["POST", "https://gmail.googleapis.com/batch/gmail/v1"],
    ["POST", "https://www.googleapis.com/batch/calendar/v3"],
    ["POST", "https://www.googleapis.com/BATCH/calendar/v3"],
    ["POST", "https://www.googleapis.com/%62atch/calendar/v3"],
    // Secrets under a read scope, in any case or encoding (once, or twice
    // for a layer that decodes again).
    [
      "GET",
      "https://analyticsadmin.googleapis.com/v1beta/properties/1/dataStreams/2/measurementProtocolSecrets",
    ],
    [
      "GET",
      "https://analyticsadmin.googleapis.com/v1beta/properties/1/dataStreams/2/MEASUREMENTPROTOCOLSECRETS",
    ],
    [
      "GET",
      "https://analyticsadmin.googleapis.com/v1beta/properties/1/dataStreams/2/measurement%50rotocolSecrets",
    ],
    [
      "GET",
      "https://analyticsadmin.googleapis.com/v1beta/properties/1/dataStreams/2/%6deasurementProtocolSecrets",
    ],
    [
      "GET",
      "https://analyticsadmin.googleapis.com/v1beta/properties/1/dataStreams/2/measurement%2550rotocolSecrets",
    ],
    // Traversals and separators the provider might resolve.
    [
      "GET",
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/..%2F..%2Fsettings%2FsendAs",
    ],
    ["GET", "https://gmail.googleapis.com/gmail/v1/users/me/%2E%2E%2Fsettings"],
    [
      "GET",
      "https://gmail.googleapis.com/gmail/v1/users/me/%252e%252e/settings",
    ],
    [
      "GET",
      "https://gmail.googleapis.com/gmail/v1/users/me/%252e%252e%3B/settings",
    ],
    ["GET", "https://gmail.googleapis.com/gmail/v1/users//me/messages"],
    ["GET", "https://gmail.googleapis.com/gmail/v1/users/me%5C..%5Csettings"],
    ["GET", "https://gmail.googleapis.com/gmail/v1/users/me%00/messages"],
    ["GET", "https://gmail.googleapis.com/gmail/v1/users/me%0A/messages"],
    ["GET", "https://gmail.googleapis.com/gmail/v1/users/me%E2%80%8B/messages"],
    ["GET", "https://gmail.googleapis.com/gmail/v1/users/me%2525/messages"],
    ["GET", "https://gmail.googleapis.com/gmail/v1/users/me%E0%A4%A/messages"],
    // A dot segment the URL parser resolves lands on a tunnel.
    [
      "POST",
      "https://gmail.googleapis.com/gmail/v1/users/me/../../../batch/gmail/v1",
    ],
    // Case is kept: the provider routes on the documented spelling.
    [
      "POST",
      "https://analyticsdata.googleapis.com/v1beta/properties/123:runreport",
    ],
    ["GET", "https://gmail.googleapis.com/GMAIL/v1/users/me/messages"],
    // Not https, a port, a host no set names, the token and authorize hosts, Gmail's legacy host.
    ["GET", "http://www.googleapis.com/oauth2/v3/userinfo"],
    ["GET", "https://www.googleapis.com:8443/oauth2/v3/userinfo"],
    ["GET", "https://evil.example/oauth2/v3/userinfo"],
    ["POST", "https://oauth2.googleapis.com/token"],
    ["GET", "https://accounts.google.com/o/oauth2/v2/auth"],
    ["GET", "https://www.googleapis.com/gmail/v1/users/me/messages"],
  ])("refuses %s %s with every Google set declared", (method, url) => {
    expect(allows(GOOGLE, GOOGLE_SETS, method, url)).toBeNull();
  });

  it.each([
    // Sending and writing.
    ["POST", "https://graph.microsoft.com/v1.0/me/sendMail"],
    ["POST", "https://graph.microsoft.com/v1.0/me/messages"],
    ["POST", "https://graph.microsoft.com/v1.0/me/messages/AAMk/reply"],
    ["POST", "https://graph.microsoft.com/v1.0/me/messages/AAMk/send"],
    ["POST", "https://graph.microsoft.com/v1.0/me/events"],
    ["POST", "https://graph.microsoft.com/v1.0/me/calendars"],
    // Other people's mailboxes and other data under the same permissions.
    [
      "GET",
      "https://graph.microsoft.com/v1.0/users/someone@example.com/messages",
    ],
    [
      "GET",
      "https://graph.microsoft.com/v1.0/users/someone@example.com/calendar",
    ],
    ["GET", "https://graph.microsoft.com/v1.0/me/contacts"],
    ["GET", "https://graph.microsoft.com/v1.0/me/drive/root/children"],
    [
      "GET",
      "https://graph.microsoft.com/v1.0/me/mailFolders%2F..%2F..%2Fusers%2Fx%2Fmessages",
    ],
    // The batch tunnel and the beta API, however spelled.
    ["POST", "https://graph.microsoft.com/v1.0/$batch"],
    ["POST", "https://graph.microsoft.com/v1.0/%24batch"],
    ["GET", "https://graph.microsoft.com/beta/me/messages"],
    ["GET", "https://graph.microsoft.com/BETA/me/messages"],
    // Case is kept.
    ["GET", "https://graph.microsoft.com/v1.0/me/Messages"],
    ["GET", "https://graph.microsoft.com/v1.0/ME"],
    // Not https; the token host.
    ["GET", "http://graph.microsoft.com/v1.0/me"],
    ["POST", "https://login.microsoftonline.com/common/oauth2/v2.0/token"],
  ])("refuses %s %s with every Microsoft set declared", (method, url) => {
    expect(allows(MICROSOFT, MICROSOFT_SETS, method, url)).toBeNull();
  });

  // Google's front end resolves a dot segment with a path parameter
  // (`..;`, `..;x`) like the bare one and answers a 302 to the resolved
  // path, which the URL parser leaves alone; Graph refuses them, and is
  // held to the same rule. With a plain segment in the dot's place each
  // path matches a prefix or a pattern's `[^/]+`, except Graph's one POST
  // pattern, which is exact.
  it.each(["..;", "..;x", "%2e%2e;", ".;"])(
    "refuses the dot segment %s on GET and POST, Google and Microsoft",
    (dot) => {
      const cases: [
        OAuthScopePolicy,
        string[],
        string,
        string,
        string | null,
      ][] = [
        [
          GOOGLE,
          GOOGLE_SETS,
          "GET",
          "https://www.googleapis.com/calendar/v3/{dot}/{dot}/gmail/v1/users/me/messages",
          "calendar.read",
        ],
        [
          GOOGLE,
          GOOGLE_SETS,
          "POST",
          "https://www.googleapis.com/calendar/v3/calendars/{dot}/events/watch",
          "calendar.read",
        ],
        [
          GOOGLE,
          GOOGLE_SETS,
          "POST",
          "https://gmail.googleapis.com/gmail/v1/users/{dot}/watch",
          "gmail.read",
        ],
        [
          MICROSOFT,
          MICROSOFT_SETS,
          "GET",
          "https://graph.microsoft.com/v1.0/me/messages/{dot}/{dot}/users/x/messages",
          "mail.read",
        ],
        [
          MICROSOFT,
          MICROSOFT_SETS,
          "POST",
          "https://graph.microsoft.com/v1.0/me/calendar/{dot}/calendar/getSchedule",
          null,
        ],
      ];
      for (const [policy, sets, method, template, plain] of cases) {
        const dotted = template.replaceAll("{dot}", dot);
        expect(allows(policy, sets, method, dotted), dotted).toBeNull();
        expect(
          allows(policy, sets, method, template.replaceAll("{dot}", "x")),
          template,
        ).toBe(plain);
      }
    },
  );

  // An encoded slash is part of one id to Google, never a separator (a
  // Search Console site URL relies on that), so the denied comparison is
  // of the whole segment: this is a GET of a data stream whose id doesn't
  // exist, not of the secrets, and the matcher lets it through.
  it("lets a denied word through behind an encoded slash, as one id", () => {
    expect(
      allows(
        GOOGLE,
        ["analytics.read"],
        "GET",
        "https://analyticsadmin.googleapis.com/v1beta/properties/1/dataStreams/2%2FmeasurementProtocolSecrets",
      ),
    ).toBe("analytics.read");
  });

  it("covers a Slack method by name on GET and POST alike, and a write method only with its set", () => {
    const list = "https://slack.com/api/conversations.list";
    expect(allows(SLACK, ["channels.read"], "GET", list)).toBe("channels.read");
    expect(allows(SLACK, ["channels.read"], "POST", list)).toBe(
      "channels.read",
    );
    const post = "https://slack.com/api/chat.postMessage";
    expect(allows(SLACK, ["channels.read"], "POST", post)).toBeNull();
    expect(
      allows(SLACK, ["channels.read", "messages.write"], "POST", post),
    ).toBe("messages.write");
    expect(allows(SLACK, ["messages.write"], "GET", post)).toBeNull();
  });
});
