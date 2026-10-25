import { describe, expect, it } from "vitest";
import {
  appSettings,
  evaluateAppSettings,
  setupCommand,
} from "./appSettings.js";
import {
  isRemoteMcpSecretName,
  isSettableGatewaySetting,
} from "./gatewaySettings.js";
import {
  normalizeRemoteToolName,
  parseRemoteMcpAuth,
  parseRemoteMcpBlock,
  remoteMcpAppManifest,
  isHeaderSafeToolName,
  remoteMcpAuthHeaders,
  remoteMcpDefaultDescription,
  remoteMcpIdFromUrl,
  remoteMcpIdProblem,
  remoteMcpOf,
  remoteMcpSecretName,
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
  auth: { kind: "bearer", secret: "TREG_MCP_TOKEN" },
  risk: "annotations",
  tools: {},
  rev: 1,
};

describe("the credential name family", () => {
  it("is <ID>_MCP_TOKEN by default and any _MCP_TOKEN name by choice", () => {
    expect(remoteMcpSecretName("treg")).toBe("TREG_MCP_TOKEN");
    expect(remoteMcpSecretName("my-server")).toBe("MY_SERVER_MCP_TOKEN");
    for (const name of [
      "TREG_MCP_TOKEN",
      "A1_MCP_TOKEN",
      "MY_SERVER_MCP_TOKEN",
    ]) {
      expect(isRemoteMcpSecretName(name), name).toBe(true);
      expect(isSettableGatewaySetting(name), name).toBe(true);
    }
    for (const name of [
      "_MCP_TOKEN",
      "treg_mcp_token",
      "TREG_MCP_TOKENS",
      "MCP_TOKEN",
      "OPENAI_API_KEY_MCP",
      "TREG-MCP_TOKEN",
    ]) {
      expect(isRemoteMcpSecretName(name), name).toBe(false);
    }
    // A fixed setting stays settable; a fixed provider key is not in the family.
    expect(isSettableGatewaySetting("OPENAI_API_KEY")).toBe(true);
    expect(isRemoteMcpSecretName("OPENAI_API_KEY")).toBe(false);
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

  it("derives the reserved hosts from the registries", () => {
    const hosts = reservedUpstreamHosts();
    expect(hosts).toContain("api.dataforseo.com");
    expect(hosts).toContain("api.context.dev");
    expect(hosts).toContain("api.openai.com");
    expect(hosts).toContain("www.linkedin.com");
  });
});

describe("the auth block", () => {
  it("parses each kind and fills nothing in", () => {
    expect(parseRemoteMcpAuth({ kind: "none" })).toEqual({
      ok: true,
      auth: { kind: "none" },
    });
    expect(parseRemoteMcpAuth({ kind: "oauth" })).toEqual({
      ok: true,
      auth: { kind: "oauth" },
    });
    expect(
      parseRemoteMcpAuth({ kind: "bearer", secret: "TREG_MCP_TOKEN" }),
    ).toEqual({
      ok: true,
      auth: { kind: "bearer", secret: "TREG_MCP_TOKEN" },
    });
    expect(
      parseRemoteMcpAuth({
        kind: "header",
        secret: "X_MCP_TOKEN",
        header: "X-Api-Key",
        prefix: "Key ",
      }),
    ).toEqual({
      ok: true,
      auth: {
        kind: "header",
        secret: "X_MCP_TOKEN",
        header: "X-Api-Key",
        prefix: "Key ",
      },
    });
    expect(
      parseRemoteMcpAuth({ kind: "basic", secret: "D_MCP_TOKEN" }),
    ).toEqual({
      ok: true,
      auth: { kind: "basic", secret: "D_MCP_TOKEN" },
    });
  });

  it("refuses a missing or foreign secret name, a bad kind and a routing header", () => {
    expect(parseRemoteMcpAuth({ kind: "bearer" })).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/secret/),
    });
    expect(
      parseRemoteMcpAuth({ kind: "bearer", secret: "OPENAI_API_KEY" }),
    ).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/_MCP_TOKEN/),
    });
    expect(
      parseRemoteMcpAuth({ kind: "query", secret: "A_MCP_TOKEN" }),
    ).toMatchObject({ ok: false });
    expect(
      parseRemoteMcpAuth({
        kind: "header",
        secret: "A_MCP_TOKEN",
        header: "Authorization",
      }),
    ).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/can't be Authorization/),
    });
    expect(
      parseRemoteMcpAuth({
        kind: "header",
        secret: "A_MCP_TOKEN",
        header: "Mcp-Session-Id",
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseRemoteMcpAuth({
        kind: "header",
        secret: "A_MCP_TOKEN",
        header: "bad header",
      }),
    ).toMatchObject({ ok: false });
    expect(parseRemoteMcpAuth("bearer")).toMatchObject({ ok: false });
  });

  it("builds the one header that carries the value, and nothing for none or oauth", () => {
    expect(
      remoteMcpAuthHeaders({ kind: "bearer", secret: "T" }, "abc"),
    ).toEqual({ authorization: "Bearer abc" });
    expect(
      remoteMcpAuthHeaders({ kind: "basic", secret: "T" }, "user:pw"),
    ).toEqual({
      authorization: `Basic ${btoa("user:pw")}`,
    });
    expect(
      remoteMcpAuthHeaders(
        { kind: "header", secret: "T", header: "X-Api-Key" },
        "abc",
      ),
    ).toEqual({ "X-Api-Key": "abc" });
    expect(
      remoteMcpAuthHeaders(
        { kind: "header", secret: "T", header: "X-Api-Key", prefix: "Key " },
        "abc",
      ),
    ).toEqual({
      "X-Api-Key": "Key abc",
    });
    expect(remoteMcpAuthHeaders({ kind: "none" }, "abc")).toEqual({});
    expect(remoteMcpAuthHeaders({ kind: "oauth" }, "abc")).toEqual({});
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
    expect(
      remoteMcpOf({
        remote: {
          url: "https://x",
          auth: { kind: "bearer", secret: "OPENAI_API_KEY" },
        },
      }),
    ).toBeNull();
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
  it("reads hints conservatively: explicit read-only is read, explicit destructive is destructive, else write", () => {
    expect(remoteToolRisk({ readOnlyHint: true }, block, "t")).toEqual({
      risk: "read",
      source: "hint",
    });
    expect(remoteToolRisk({ destructiveHint: true }, block, "t")).toEqual({
      risk: "destructive",
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
      tools: { t: { risk: "destructive" as const } },
    };
    expect(remoteToolRisk({ readOnlyHint: true }, overridden, "t")).toEqual({
      risk: "destructive",
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
  it("reads the credential as one required Gateway setting with the remote-mcp setup guide", () => {
    const manifest = remoteMcpAppManifest({
      id: "treg",
      name: "Treg",
      remote: block,
    });
    const settings = appSettings(manifest);
    expect(settings).toEqual([
      expect.objectContaining({
        kind: "remote-mcp",
        id: "TREG_MCP_TOKEN",
        label: "Treg credential",
        holder: "gateway",
        names: ["TREG_MCP_TOKEN"],
        need: { kind: "required" },
        setup: "setup/remote-mcp.md",
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
    ).toEqual({
      command: "pnpm everyapp secret set TREG_MCP_TOKEN",
    });
    expect(evaluateAppSettings(settings, () => true).ready).toBe(true);
  });

  it("needs nothing for a server with no credential", () => {
    const manifest = remoteMcpAppManifest({
      id: "deepwiki",
      remote: { ...block, auth: { kind: "none" } },
    });
    expect(appSettings(manifest)).toEqual([]);
  });
});
