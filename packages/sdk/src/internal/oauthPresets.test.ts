/**
 * The OAuth presets as data (./oauthPresets.ts): each spec parses like a
 * registered row and round-trips, none is in the catalog, and the one set
 * of scope rules (./oauthScopes.ts) reads each provider's spelling from
 * its spec alone.
 */
import { describe, expect, it } from "vitest";
import {
  CATALOG,
  capabilitySettings,
  oauthClientSecretSetCommand,
  type OAuthClientCapability,
  type OAuthFlow,
} from "./capabilities";
import {
  isPresetRow,
  oauthPreset,
  oauthPresetIds,
  oauthSetupGuide,
  unregisteredPresetIds,
  withOAuthPresets,
} from "./oauthPresets";
import {
  canonicalScopes,
  grantedScopes,
  joinScopes,
  missingScopes,
  requestedScopes,
  scopeExcess,
} from "./oauthScopes";

const IDS = oauthPresetIds();
const client = (id: string): OAuthClientCapability =>
  oauthPreset(id) as OAuthClientCapability;
const flow = (id: string): OAuthFlow => client(id).flow;

describe("the presets", () => {
  it("are Google, Microsoft and Slack first, then the rest, none in the catalog", () => {
    expect(IDS.slice(0, 3)).toEqual([
      "google-workspace",
      "microsoft-365",
      "slack",
    ]);
    expect(IDS).toContain("github-oauth");
    for (const id of IDS) expect(CATALOG.get(id), id).toBeUndefined();
  });

  it.each(IDS)(
    "%s is a flow and API hosts, with no scopes, access or routes of its own",
    (id) => {
      const capability = client(id);
      for (const field of [
        "access",
        "token",
        "authorize",
        "scopePolicy",
        "readMethods",
        "writeMethods",
      ]) {
        expect(capability, field).not.toHaveProperty(field);
      }
      expect(capability.api.length).toBeGreaterThan(0);
      for (const host of capability.api) {
        // A bare lowercase host: no scheme, port, path or credentials.
        expect(new URL(`https://${host}`).host).toBe(host);
        expect(host).toMatch(/^[a-z0-9.-]+$/);
      }
      const { flow } = capability;
      for (const url of [
        flow.authorizeUrl,
        flow.tokenUrl,
        capability.console,
        ...(flow.revokeUrl ? [flow.revokeUrl] : []),
      ]) {
        expect(new URL(url).protocol, url).toBe("https:");
      }
      // The identity URL gets the token: it must be one of the API hosts.
      if (flow.identity) {
        expect(capability.api).toContain(new URL(flow.identity.url).host);
      }
      expect(capability.secrets.clientSecret).toBeDefined();
      expect(flow.authorizeParams ?? {}).not.toHaveProperty(
        // Would widen a token past the app's scopes.
        "include_granted_scopes",
      );
    },
  );

  it("name their settings after their ids, each preset its own", () => {
    const settings = IDS.flatMap((id) => capabilitySettings(client(id)));
    expect(new Set(settings).size).toBe(settings.length);
    expect(client("slack").secrets).toEqual({
      clientId: "SLACK_CLIENT_ID",
      clientSecret: "SLACK_CLIENT_SECRET",
    });
    expect(oauthClientSecretSetCommand(client("slack"))).toBe(
      "pnpm everyapp secret set SLACK_CLIENT_ID SLACK_CLIENT_SECRET",
    );
  });

  it("revoke Google's grant at its revoke endpoint, a POST form", () => {
    expect(flow("google-workspace").revokeUrl).toBe(
      "https://oauth2.googleapis.com/revoke",
    );
    expect(flow("google-workspace").revokeMethod).toBeUndefined();
  });

  it("point Google, Microsoft and Slack at their setup guides", () => {
    expect(oauthSetupGuide("google-workspace")).toBe("setup/google.md");
    expect(oauthSetupGuide("microsoft-365")).toBe("setup/microsoft-365.md");
    expect(oauthSetupGuide("slack")).toBe("setup/slack.md");
    expect(oauthSetupGuide("github-oauth")).toBeUndefined();
  });
});

describe("a preset's row", () => {
  it("is the preset's while its client would go where the preset says, never under another spec", () => {
    expect(isPresetRow("google-workspace", client("google-workspace"))).toBe(
      true,
    );
    const moved = {
      ...client("google-workspace"),
      flow: {
        ...flow("google-workspace"),
        tokenUrl: "https://tokens.example.com/token",
      },
    };
    expect(isPresetRow("google-workspace", moved)).toBe(false);
    expect(isPresetRow("acme", client("google-workspace"))).toBe(false);
  });
});

describe("presets before a Gateway registers them", () => {
  it("names the presets an app lists that a registry lacks, once each", () => {
    const registry = withOAuthPresets(CATALOG);
    expect(
      unregisteredPresetIds(
        ["google-workspace", "dataforseo", "slack", "google-workspace"],
        CATALOG,
      ),
    ).toEqual(["google-workspace", "slack"]);
    expect(unregisteredPresetIds(["google-workspace"], registry)).toEqual([]);
  });

  it("looks a preset up as its row would be, after the catalog", () => {
    const lookup = withOAuthPresets(CATALOG);
    expect(lookup.get("google-workspace")).toEqual(
      oauthPreset("google-workspace"),
    );
    expect(lookup.get("dataforseo")).toBe(CATALOG.get("dataforseo"));
    expect(lookup.get("nope")).toBeUndefined();
    expect(lookup.ids()).toEqual([...CATALOG.ids(), ...IDS]);
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
