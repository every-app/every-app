import { describe, expect, it } from "vitest";
import {
  appSettings,
  evaluateAppSettings,
  setupCommand,
} from "./appSettings.js";
import { CAPABILITIES, type Capability } from "./capabilities.js";
import { isSettableGatewaySetting } from "./gatewaySettings.js";
import { mcpOAuthProviderSpec, mcpStaticProviderSpec } from "./mcpOAuth.js";
import { providerRegistry, rowSecretProblem } from "./providerRegistry.js";
import { parseProviderSpec } from "./providerSpec.js";
import {
  normalizeRemoteToolName,
  parseRemoteMcpAuth,
  parseRemoteMcpBlock,
  remoteMcpAppManifest,
  remoteMcpAuthLabel,
  remoteMcpBlockProblem,
  isHeaderSafeToolName,
  remoteMcpClientIdSetting,
  remoteMcpClientSecretSetting,
  remoteMcpDefaultDescription,
  remoteMcpHeaderProblem,
  remoteMcpIdFromUrl,
  remoteMcpIdProblem,
  remoteMcpOf,
  remoteMcpProviderHosts,
  remoteMcpProviderId,
  remoteMcpRedirectUri,
  remoteMcpTokenSetting,
  remoteMcpUrlProblem,
  remoteToolEnabled,
  remoteToolOverride,
  remoteToolRisk,
  reservedUpstreamHosts,
  type RemoteMcpBlock,
} from "./remoteMcp.js";

const LIVE = {
  gatewayUrl: "https://apps.example.com",
  appBaseDomain: "apps.example.com",
};
const LOCAL = { gatewayUrl: "http://localhost:3000" };

const block: RemoteMcpBlock = {
  url: "https://treg.to/mcp/",
  auth: { kind: "provider", provider: "treg-mcp" },
  risk: "annotations",
  tools: {},
  rev: 1,
};

function capabilityOf(
  built: ReturnType<typeof mcpStaticProviderSpec>,
): Capability {
  if (!built.ok) throw new Error(built.problem);
  const parsed = parseProviderSpec(built.spec);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
  return parsed.capability;
}

const tregStatic = capabilityOf(
  mcpStaticProviderSpec({
    appId: "treg",
    name: "Treg",
    url: "https://treg.to/mcp/",
    kind: "bearer",
  }),
);
const tregOAuth = capabilityOf(
  mcpOAuthProviderSpec({
    appId: "treg",
    name: "Treg",
    url: "https://treg.to/mcp/",
    discovery: {
      resource: "https://treg.to/mcp/",
      issuer: "https://auth.treg.to",
      authorizationEndpoint: "https://auth.treg.to/authorize",
      tokenEndpoint: "https://auth.treg.to/token",
      scopes: [],
      tokenEndpointAuthMethods: ["none"],
      resourceMetadata: true,
    },
    client: { hasSecret: false, inject: "form" },
  }),
);

describe("the app's own provider and its setting names", () => {
  it("is <id>-mcp, with <ID>_MCP_TOKEN and <ID>_MCP_CLIENT_ID/SECRET", () => {
    expect(remoteMcpProviderId("treg")).toBe("treg-mcp");
    expect(remoteMcpTokenSetting("treg")).toBe("TREG_MCP_TOKEN");
    expect(remoteMcpTokenSetting("my-server")).toBe("MY_SERVER_MCP_TOKEN");
    expect(remoteMcpClientIdSetting("my-server")).toBe(
      "MY_SERVER_MCP_CLIENT_ID",
    );
    expect(remoteMcpClientSecretSetting("treg")).toBe("TREG_MCP_CLIENT_SECRET");
    expect(remoteMcpRedirectUri("https://apps.example.com/", "treg")).toBe(
      "https://apps.example.com/connect/treg-mcp/callback",
    );
    expect(remoteMcpRedirectUri("http://localhost:3000", "a-b")).toBe(
      "http://localhost:3000/connect/a-b-mcp/callback",
    );
  });

  it("are no longer a Gateway family: the row holds them as its own", () => {
    for (const name of [
      "TREG_MCP_TOKEN",
      "TREG_MCP_CLIENT_ID",
      "TREG_MCP_CLIENT_SECRET",
    ]) {
      expect(isSettableGatewaySetting(name), name).toBe(false);
      expect(
        rowSecretProblem("treg-mcp", name, () => false),
        name,
      ).toBeNull();
    }
    // Another app's row can't take them.
    expect(
      rowSecretProblem("other-mcp", "TREG_MCP_TOKEN", () => false),
    ).toMatch(/doesn't start with OTHER_MCP_/);
    // A fixed setting stays settable.
    expect(isSettableGatewaySetting("OPENAI_API_KEY")).toBe(true);
  });

  it("names the hosts a provider sends its credential to, or null when it can't serve an MCP app", () => {
    expect(remoteMcpProviderHosts(tregStatic)).toEqual(["treg.to"]);
    expect(remoteMcpProviderHosts(tregOAuth)).toEqual(["treg.to"]);
    expect(
      remoteMcpProviderHosts(
        CAPABILITIES["elevenlabs" as keyof typeof CAPABILITIES] as Capability,
      ),
    ).toEqual(["api.elevenlabs.io"]);
    expect(
      remoteMcpProviderHosts(
        CAPABILITIES["openai" as keyof typeof CAPABILITIES] as Capability,
      ),
    ).toBeNull();
  });
});

describe("the app id", () => {
  it("comes from the URL's registrable name, mcp/api/www dropped", () => {
    expect(remoteMcpIdFromUrl("https://treg.to/mcp/")).toBe("treg");
    expect(remoteMcpIdFromUrl("https://mcp.deepwiki.com/mcp")).toBe("deepwiki");
    expect(remoteMcpIdFromUrl("https://docs.mcp.cloudflare.com/mcp")).toBe(
      "cloudflare",
    );
    expect(remoteMcpIdFromUrl("https://api.example.co.uk/mcp")).toBe("example");
    expect(remoteMcpIdFromUrl("http://127.0.0.1:8787/mcp")).toBeNull();
    expect(remoteMcpIdFromUrl("http://localhost:8787/mcp")).toBeNull();
    expect(remoteMcpIdFromUrl("not a url")).toBeNull();
  });

  it("refuses ids that are reserved, a built-in's, or not kebab-case", () => {
    expect(remoteMcpIdProblem("treg")).toBeNull();
    expect(remoteMcpIdProblem("everyapp")).toMatch(/reserved/);
    expect(remoteMcpIdProblem("dataforseo")).toMatch(/built-in/);
    expect(remoteMcpIdProblem("Treg")).toMatch(/kebab-case/);
    expect(remoteMcpIdProblem("a_b")).toMatch(/kebab-case/);
    expect(remoteMcpIdProblem("a".repeat(33))).toMatch(/at most 32/);
  });
});

describe("the URL rule", () => {
  it("takes a public https URL and refuses everything the Gateway holds or serves", () => {
    expect(remoteMcpUrlProblem("https://treg.to/mcp/", LIVE)).toBeNull();
    expect(remoteMcpUrlProblem("http://treg.to/mcp/", LIVE)).toMatch(/https/);
    expect(remoteMcpUrlProblem("https://user:pw@treg.to/mcp", LIVE)).toMatch(
      /credentials/,
    );
    expect(remoteMcpUrlProblem("https://treg.to/mcp#x", LIVE)).toMatch(
      /fragment/,
    );
    expect(remoteMcpUrlProblem("https://1.2.3.4/mcp", LIVE)).toMatch(
      /IP address/,
    );
    expect(remoteMcpUrlProblem("https://localhost/mcp", LIVE)).toMatch(
      /public host/,
    );
    expect(remoteMcpUrlProblem("https://apps.example.com/mcp", LIVE)).toMatch(
      /own address/,
    );
    expect(
      remoteMcpUrlProblem("https://crm.apps.example.com/mcp", LIVE),
    ).toMatch(/own address|app domain/);
    expect(
      remoteMcpUrlProblem("https://apps.example.com:8443/mcp", LIVE),
    ).toMatch(/own address/);
    expect(remoteMcpUrlProblem("https://APPS.example.com./mcp", LIVE)).toMatch(
      /own address/,
    );
    expect(remoteMcpUrlProblem("https://api.openai.com/mcp", LIVE)).toMatch(
      /holds a key/,
    );
    expect(remoteMcpUrlProblem("https://api.dataforseo.com/mcp", LIVE)).toMatch(
      /holds a key/,
    );
    expect(remoteMcpUrlProblem("", LIVE)).toMatch(/give the server's URL/);
    expect(remoteMcpUrlProblem("nope", LIVE)).toMatch(/doesn't parse/);
  });

  it("allows http on loopback only while the Gateway itself runs on http", () => {
    expect(remoteMcpUrlProblem("http://localhost:8787/mcp", LOCAL)).toBeNull();
    expect(remoteMcpUrlProblem("http://127.0.0.1:8787/mcp", LOCAL)).toBeNull();
    expect(remoteMcpUrlProblem("http://treg.to/mcp", LOCAL)).toMatch(
      /localhost/,
    );
    expect(remoteMcpUrlProblem("http://localhost:8787/mcp", LIVE)).toMatch(
      /https/,
    );
  });

  it("lets a reserved host through only for the provider the app names", () => {
    expect(
      remoteMcpUrlProblem("https://api.elevenlabs.io/v1/mcp", LIVE),
    ).toMatch(/holds a key/);
    expect(
      remoteMcpUrlProblem("https://api.elevenlabs.io/v1/mcp", LIVE, {
        providerHosts: ["api.elevenlabs.io"],
      }),
    ).toBeNull();
    expect(
      remoteMcpUrlProblem("https://api.openai.com/mcp", LIVE, {
        providerHosts: ["api.elevenlabs.io"],
      }),
    ).toMatch(/holds a key/);
    // The Gateway's own hosts and IPs stay refused whatever the provider.
    expect(
      remoteMcpUrlProblem("https://apps.example.com/mcp", LIVE, {
        providerHosts: ["apps.example.com"],
      }),
    ).toMatch(/own address/);
    expect(
      remoteMcpUrlProblem("https://1.2.3.4/mcp", LIVE, {
        providerHosts: ["1.2.3.4"],
      }),
    ).toMatch(/IP address/);
  });

  it("derives the reserved hosts from the registries", () => {
    const hosts = reservedUpstreamHosts();
    expect(hosts).toContain("api.dataforseo.com");
    expect(hosts).toContain("api.context.dev");
    expect(hosts).toContain("api.openai.com");
    expect(hosts).toContain("slack.com");
  });
});

describe("the auth block", () => {
  it("parses none and a provider", () => {
    expect(parseRemoteMcpAuth({ kind: "none" })).toEqual({
      ok: true,
      auth: { kind: "none" },
    });
    expect(
      parseRemoteMcpAuth({ kind: "provider", provider: "treg-mcp" }),
    ).toEqual({ ok: true, auth: { kind: "provider", provider: "treg-mcp" } });
    // Organization connections are gone: an account is no field.
    expect(
      parseRemoteMcpAuth({
        kind: "provider",
        provider: "github",
        account: "organization",
      }),
    ).toMatchObject({ ok: false });
  });

  it("refuses the kinds from before provider credentials, and a bad provider or account", () => {
    for (const old of [
      { kind: "bearer", secret: "TREG_MCP_TOKEN" },
      { kind: "header", secret: "X_MCP_TOKEN", header: "X-Api-Key" },
      { kind: "basic", secret: "D_MCP_TOKEN" },
      { kind: "oauth" },
    ]) {
      expect(parseRemoteMcpAuth(old)).toEqual({
        ok: false,
        problem:
          "this registration predates provider credentials; remove it and add it again",
      });
    }
    expect(parseRemoteMcpAuth({ kind: "provider" })).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/auth.provider/),
    });
    expect(
      parseRemoteMcpAuth({ kind: "provider", provider: "Treg" }),
    ).toMatchObject({ ok: false });
    expect(
      parseRemoteMcpAuth({
        kind: "provider",
        provider: "t-mcp",
        account: "me",
      }),
    ).toMatchObject({ ok: false, problem: expect.stringMatching(/account/) });
    expect(
      parseRemoteMcpAuth({ kind: "provider", provider: "t-mcp", secret: "X" }),
    ).toMatchObject({ ok: false });
    expect(parseRemoteMcpAuth({ kind: "query" })).toMatchObject({ ok: false });
    expect(parseRemoteMcpAuth("none")).toMatchObject({ ok: false });
  });

  it("refuses a header the transport or the Gateway sets", () => {
    expect(remoteMcpHeaderProblem("X-Api-Key")).toBeNull();
    expect(remoteMcpHeaderProblem("Authorization")).toMatch(/--auth bearer/);
    expect(remoteMcpHeaderProblem("Mcp-Session-Id")).toMatch(/can't be/);
    expect(remoteMcpHeaderProblem("bad header")).toMatch(/header name/);
  });

  it("says in plain words how the app authenticates", () => {
    expect(remoteMcpAuthLabel({ kind: "none" })).toBe("no credential");
    const own = { kind: "provider" as const, provider: "treg-mcp" };
    expect(remoteMcpAuthLabel(own)).toBe("provider treg-mcp");
    expect(remoteMcpAuthLabel(own, tregStatic)).toBe("bearer token");
    expect(remoteMcpAuthLabel(own, tregOAuth)).toBe(
      "OAuth, each member connects",
    );
    expect(
      remoteMcpAuthLabel(
        { kind: "provider", provider: "elevenlabs" },
        CAPABILITIES["elevenlabs" as keyof typeof CAPABILITIES] as Capability,
      ),
    ).toBe("header xi-api-key, ElevenLabs's key");
  });
});

describe("the stored block", () => {
  it("round-trips through the manifest and is read back strictly", () => {
    const manifest = remoteMcpAppManifest({ id: "treg", remote: block });
    expect(manifest.name).toBe("treg");
    // The origin only: a path or query may carry something meant for the server alone.
    expect(manifest.description).toBe(
      "treg's MCP server at https://treg.to, served to your AI clients through this Gateway.",
    );
    expect(
      remoteMcpDefaultDescription(
        "X",
        "https://x.example/mcp?key=abc",
      ).includes("key=abc"),
    ).toBe(false);
    expect(remoteMcpOf(JSON.parse(JSON.stringify(manifest)))).toEqual(block);
    expect(remoteMcpOf({ id: "crm" })).toBeNull();
    const old = {
      remote: {
        url: "https://x",
        auth: { kind: "bearer", secret: "X_MCP_TOKEN" },
      },
    };
    expect(remoteMcpOf(old)).toBeNull();
    expect(remoteMcpBlockProblem(old)).toMatch(/predates provider credentials/);
    expect(remoteMcpBlockProblem(manifest)).toBeNull();
  });

  it("defaults risk and rev, checks each override, and bounds the map", () => {
    const parsed = parseRemoteMcpBlock({
      url: "https://treg.to/mcp/",
      auth: { kind: "none" },
      tools: { getUser: { risk: "read" }, deleteAll: { enabled: false } },
    });
    expect(parsed).toEqual({
      ok: true,
      block: {
        url: "https://treg.to/mcp/",
        auth: { kind: "none" },
        risk: "annotations",
        tools: { getUser: { risk: "read" }, deleteAll: { enabled: false } },
        rev: 1,
      },
    });
    expect(
      parseRemoteMcpBlock({
        url: "https://x",
        auth: { kind: "none" },
        risk: "maybe",
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseRemoteMcpBlock({
        url: "https://x",
        auth: { kind: "none" },
        tools: { a: { risk: "nuke" } },
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseRemoteMcpBlock({ url: "https://x", auth: { kind: "none" }, rev: 0 }),
    ).toMatchObject({ ok: false });
    expect(parseRemoteMcpBlock({ auth: { kind: "none" } })).toMatchObject({
      ok: false,
    });
  });
});

describe("a tool's risk and name", () => {
  it("reads hints conservatively: explicit read-only is read, anything else write", () => {
    expect(remoteToolRisk({ readOnlyHint: true }, block, "t")).toEqual({
      risk: "read",
      source: "hint",
    });
    expect(remoteToolRisk({ destructiveHint: true }, block, "t")).toEqual({
      risk: "write",
      source: "hint",
    });
    expect(
      remoteToolRisk({ readOnlyHint: true, destructiveHint: true }, block, "t"),
    ).toEqual({ risk: "read", source: "hint" });
    expect(remoteToolRisk({ readOnlyHint: false }, block, "t")).toEqual({
      risk: "write",
      source: "default",
    });
    expect(remoteToolRisk({ destructiveHint: false }, block, "t")).toEqual({
      risk: "write",
      source: "default",
    });
    expect(remoteToolRisk(undefined, block, "t")).toEqual({
      risk: "write",
      source: "default",
    });
    expect(remoteToolRisk({ readOnlyHint: "true" }, block, "t")).toEqual({
      risk: "write",
      source: "default",
    });
  });

  it("lets the app's default and a per-tool override win, in that order", () => {
    const readAll = { ...block, risk: "read" as const };
    expect(remoteToolRisk({ destructiveHint: true }, readAll, "t")).toEqual({
      risk: "read",
      source: "app",
    });
    const writeAll = { ...block, risk: "write" as const };
    expect(remoteToolRisk({ readOnlyHint: true }, writeAll, "t")).toEqual({
      risk: "write",
      source: "app",
    });
    const overridden = {
      ...readAll,
      tools: { t: { risk: "write" as const } },
    };
    expect(remoteToolRisk({ readOnlyHint: true }, overridden, "t")).toEqual({
      risk: "write",
      source: "override",
    });
    expect(remoteToolEnabled({ tools: { t: { enabled: false } } }, "t")).toBe(
      false,
    );
    expect(remoteToolEnabled({ tools: {} }, "t")).toBe(true);
  });

  it("finds an override by the server's name or by the ToolBus name it becomes", () => {
    const withOverrides = {
      tools: {
        "send-mail": { enabled: false },
        GetUser: { risk: "read" as const },
      },
    };
    expect(remoteToolOverride(withOverrides, "send-mail")).toEqual({
      enabled: false,
    });
    expect(remoteToolOverride(withOverrides, "send_mail")).toEqual({
      enabled: false,
    });
    expect(remoteToolOverride(withOverrides, "sendMail")).toEqual({
      enabled: false,
    });
    expect(remoteToolOverride(withOverrides, "getUser")).toEqual({
      risk: "read",
    });
    expect(remoteToolOverride(withOverrides, "other")).toBeUndefined();
    expect(remoteToolEnabled(withOverrides, "send_mail")).toBe(false);
    expect(isHeaderSafeToolName("getUser")).toBe(true);
    expect(isHeaderSafeToolName("get user")).toBe(false);
    expect(isHeaderSafeToolName("get\nuser")).toBe(false);
    expect(isHeaderSafeToolName("ünïcode")).toBe(false);
    expect(isHeaderSafeToolName("a".repeat(257))).toBe(false);
  });

  it("normalizes a server's names to the ToolBus's shape", () => {
    expect(normalizeRemoteToolName("getUser")).toBe("get_user");
    expect(normalizeRemoteToolName("search-web")).toBe("search_web");
    expect(normalizeRemoteToolName("read_wiki_structure")).toBe(
      "read_wiki_structure",
    );
    expect(normalizeRemoteToolName("HTTPRequest")).toBe("http_request");
    expect(normalizeRemoteToolName("files.read")).toBe("files_read");
    expect(normalizeRemoteToolName("  List Items  ")).toBe("list_items");
    expect(normalizeRemoteToolName("2fa_check")).toBe("t_2fa_check");
    expect(normalizeRemoteToolName("a".repeat(60))).toBe("a".repeat(48));
    expect(normalizeRemoteToolName("???")).toBeNull();
    expect(normalizeRemoteToolName("")).toBeNull();
  });
});

describe("the settings model", () => {
  it("lists the app's provider as a capability, so its key is a Gateway setting like any app's", () => {
    const manifest = remoteMcpAppManifest({
      id: "treg",
      name: "Treg",
      remote: block,
      providerCapability: tregStatic,
    });
    expect(manifest.capabilities).toEqual({
      "treg-mcp": {
        access: "read",
        why: "Treg's MCP server at https://treg.to takes this credential; the Gateway sends it there when a member calls the app's tools.",
      },
    });
    const registry = providerRegistry([
      {
        id: "treg-mcp",
        spec: (
          mcpStaticProviderSpec({
            appId: "treg",
            name: "Treg",
            url: "https://treg.to/mcp/",
            kind: "bearer",
          }) as { spec: unknown }
        ).spec,
      },
    ]);
    const settings = appSettings(manifest, registry);
    expect(settings).toEqual([
      expect.objectContaining({
        kind: "capability",
        id: "treg-mcp",
        label: "Treg MCP server",
        holder: "gateway",
        names: ["TREG_MCP_TOKEN"],
        need: { kind: "required" },
      }),
    ]);
    const unset = evaluateAppSettings(settings, () => false);
    expect(unset.ready).toBe(false);
    expect(
      setupCommand(unset, {
        cli: "pnpm everyapp",
        appId: "treg",
        provider: true,
      }),
    ).toEqual({ command: "pnpm everyapp secret set TREG_MCP_TOKEN" });
    expect(evaluateAppSettings(settings, () => true).ready).toBe(true);
  });

  it("asks for an OAuth row's client, and lists its scopes", () => {
    const manifest = remoteMcpAppManifest({
      id: "treg",
      name: "Treg",
      remote: {
        ...block,
        auth: { kind: "provider", provider: "treg-mcp" },
      },
      providerCapability: tregOAuth,
      scopes: ["mcp:read"],
    });
    expect(manifest.capabilities?.["treg-mcp"]).toEqual({
      scopes: ["mcp:read"],
      why: expect.any(String),
    });
    const settings = appSettings(manifest, {
      get: (id) => (id === "treg-mcp" ? tregOAuth : undefined),
      ids: () => ["treg-mcp"],
    });
    expect(settings).toEqual([
      expect.objectContaining({
        kind: "capability",
        id: "treg-mcp",
        names: ["TREG_MCP_CLIENT_ID"],
      }),
    ]);
  });

  it("needs nothing for a server with no credential", () => {
    const manifest = remoteMcpAppManifest({
      id: "deepwiki",
      remote: { ...block, auth: { kind: "none" } },
    });
    expect(manifest.capabilities).toBeUndefined();
    expect(appSettings(manifest)).toEqual([]);
  });

  it("reads a registration from before provider credentials as needing setup: remove and add again", () => {
    const settings = appSettings({
      name: "Treg",
      remote: {
        url: "https://treg.to/mcp/",
        auth: { kind: "bearer", secret: "TREG_MCP_TOKEN" },
      },
    });
    expect(settings).toEqual([
      expect.objectContaining({
        kind: "remote-mcp",
        id: "remote",
        names: [],
        need: { kind: "required" },
        why: expect.stringMatching(/predates provider credentials/),
      }),
    ]);
    const report = evaluateAppSettings(settings, () => true);
    expect(report.ready).toBe(false);
    expect(
      setupCommand(report, {
        cli: "pnpm everyapp",
        appId: "treg",
        provider: true,
      }),
    ).toEqual({ command: "pnpm everyapp mcp remove treg" });
  });
});
