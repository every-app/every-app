/**
 * The built-in OAuth providers as data (./oauthBuiltIns.ts): each spec
 * parses like a registered row, is exactly its catalog entry, and round
 * trips; and the one set of scope rules (./oauthScopes.ts) reads each
 * provider's spelling from its spec alone.
 */
import { describe, expect, it } from "vitest";
import { CAPABILITIES, type OAuthFlow } from "./capabilities";
import { BUILT_IN_OAUTH_SPECS, type BuiltInOAuthId } from "./oauthBuiltIns";
import {
  canonicalScopes,
  grantedScopes,
  joinScopes,
  missingScopes,
  requestedScopes,
  scopeExcess,
} from "./oauthScopes";
import { parseProviderSpec, providerSpecOf } from "./providerSpec";

const IDS = Object.keys(BUILT_IN_OAUTH_SPECS) as BuiltInOAuthId[];
const flow = (id: BuiltInOAuthId): OAuthFlow => CAPABILITIES[id].flow;

describe("the built-in specs", () => {
  it("are Google, Microsoft and Slack, under their catalog ids", () => {
    expect([...IDS].sort()).toEqual([
      "google-workspace",
      "microsoft-365",
      "slack",
    ]);
  });

  it.each(IDS)(
    "%s parses as a registered row would, equals its catalog entry minus setup, and round-trips",
    (id) => {
      const spec = BUILT_IN_OAUTH_SPECS[id];
      const parsed = parseProviderSpec(spec);
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
      expect(parsed.id).toBe(id);
      const { setup, ...entry } = CAPABILITIES[id];
      expect(setup).toMatch(/^setup\/.+\.md$/);
      expect(parsed.capability).toEqual(entry);
      const again = parseProviderSpec(providerSpecOf(id, parsed.capability));
      if (!again.ok) throw new Error(JSON.stringify(again.problems));
      expect(again.capability).toEqual(parsed.capability);
    },
  );

  it("never send include_granted_scopes, which would widen a token past the app's scopes", () => {
    for (const id of IDS) {
      expect(flow(id).authorizeParams ?? {}).not.toHaveProperty(
        "include_granted_scopes",
      );
    }
  });
});

describe("Google's scopes", () => {
  const google = flow("google-workspace");
  const declared = ["gmail.modify", "gmail.send"];

  it("asks for the app's short scopes in full, with the identity scopes, space-separated", () => {
    const asked = requestedScopes(google, declared);
    expect(asked).toEqual([
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send",
      "openid",
      "email",
    ]);
    expect(joinScopes(google, asked)).toBe(
      "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send openid email",
    );
    // A scope the app writes in full is the same scope.
    expect(
      requestedScopes(google, ["https://www.googleapis.com/auth/gmail.modify"]),
    ).toEqual([
      "https://www.googleapis.com/auth/gmail.modify",
      "openid",
      "email",
    ]);
  });

  it("keeps a token holding exactly those, the userinfo spellings tolerated", () => {
    const asked = requestedScopes(google, declared);
    const granted = grantedScopes(
      google,
      {
        access_token: "t",
        scope:
          "https://www.googleapis.com/auth/gmail.send openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.modify profile",
      },
      asked,
    );
    expect(granted).toEqual([
      "gmail.send",
      "openid",
      "userinfo.email",
      "gmail.modify",
      "profile",
    ]);
    expect(scopeExcess(google, granted!, asked)).toEqual([]);
    expect(missingScopes(google, granted!, declared)).toEqual([]);
  });

  it("refuses a token carrying a scope another app asked for", () => {
    const asked = requestedScopes(google, ["webmasters.readonly"]);
    const granted = grantedScopes(
      google,
      {
        scope:
          "https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/gmail.modify openid email",
      },
      asked,
    );
    expect(scopeExcess(google, granted!, asked)).toEqual(["gmail.modify"]);
  });
});

describe("Microsoft's scopes", () => {
  const microsoft = flow("microsoft-365");
  const declared = ["Mail.Read"];

  it("asks for Graph's scopes qualified, with User.Read and offline_access", () => {
    expect(requestedScopes(microsoft, declared)).toEqual([
      "https://graph.microsoft.com/Mail.Read",
      "User.Read",
      "offline_access",
    ]);
  });

  it.each([
    [
      "prefixed",
      "https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read",
    ],
    ["bare and mixed case", "mail.read user.read"],
    [
      "percent-encoded",
      "https%3A%2F%2Fgraph.microsoft.com%2FMail.Read%20User.Read",
    ],
    ["with openid and profile", "Mail.Read User.Read openid profile email"],
  ])("reads an answer %s as within the app's scopes", (_, scope) => {
    const asked = requestedScopes(microsoft, declared);
    const granted = grantedScopes(
      microsoft,
      { access_token: "t", scope },
      asked,
    );
    expect(granted).not.toBeNull();
    expect(scopeExcess(microsoft, granted!, asked)).toEqual([]);
    expect(missingScopes(microsoft, granted!, declared)).toEqual([]);
  });

  it("refuses a token carrying another app's scope on a shared client", () => {
    const asked = requestedScopes(microsoft, declared);
    const granted = grantedScopes(
      microsoft,
      { scope: "Mail.Read Mail.Send User.Read" },
      asked,
    );
    expect(scopeExcess(microsoft, granted!, asked)).toEqual(["mail.send"]);
  });
});

describe("Slack's scopes", () => {
  const slack = flow("slack");
  const declared = ["channels:read", "chat:write"];

  it("asks for the bot scopes as written, comma-separated, with none of its own", () => {
    const asked = requestedScopes(slack, declared);
    expect(asked).toEqual(["channels:read", "chat:write"]);
    expect(joinScopes(slack, asked)).toBe("channels:read,chat:write");
  });

  it("reads the top-level (bot) token's comma-separated scopes", () => {
    const asked = requestedScopes(slack, declared);
    const granted = grantedScopes(
      slack,
      {
        ok: true,
        access_token: "xoxb-1",
        scope: "chat:write,channels:read",
        authed_user: { id: "U1", scope: "search:read" },
      },
      asked,
    );
    expect(granted).toEqual(["chat:write", "channels:read"]);
    expect(scopeExcess(slack, granted!, asked)).toEqual([]);
  });

  it("refuses a reinstall that carries scopes another app asked for", () => {
    const asked = requestedScopes(slack, declared);
    const granted = grantedScopes(
      slack,
      { scope: "channels:read,chat:write,files:write" },
      asked,
    );
    expect(scopeExcess(slack, granted!, asked)).toEqual(["files:write"]);
  });
});

describe("the rules every provider shares", () => {
  it.each(IDS)(
    "%s: an answer with no scope field is taken as granted exactly as asked",
    (id) => {
      const asked = requestedScopes(flow(id), ["x.read"]);
      const granted = grantedScopes(flow(id), { access_token: "t" }, asked);
      expect(granted).toEqual(canonicalScopes(flow(id), asked));
      expect(scopeExcess(flow(id), granted!, asked)).toEqual([]);
      expect(missingScopes(flow(id), granted!, ["x.read"])).toEqual([]);
    },
  );

  it.each(IDS)(
    "%s: a connection made before the app listed a scope is missing it",
    (id) => {
      const held = canonicalScopes(
        flow(id),
        requestedScopes(flow(id), ["x.read"]),
      );
      expect(missingScopes(flow(id), held, ["x.read", "x.write"])).toEqual([
        "x.write",
      ]);
    },
  );
});
