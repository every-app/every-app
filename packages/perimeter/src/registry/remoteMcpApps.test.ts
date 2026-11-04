import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  mcpOAuthProviderSpec,
  mcpStaticProviderSpec,
  parseProviderSpec,
  PROVIDER_APP_TIER,
  providerBindingKey,
  providerRegistry,
  remoteMcpOf,
  type Capability,
  type McpOAuthDiscovery,
} from "@every-app/sdk/internal";
import {
  appNotMeteredMessage,
  isMeteredAppRow,
  isRemoteMcpRow,
  mcpAppRemoveUpdate,
  mcpAppStatusUpdate,
  planRemoteMcpAppAdd,
  planRemoteMcpProviderRow,
  remoteMcpAppUpdate,
  remoteMcpBlockOf,
  type RemoteMcpAddInput,
} from "./remoteMcpApps";
import { planProviderAppOn } from "./providerApps";
import type { AppRow } from "./registration";

const NOW = Date.parse("2026-10-25T12:00:00Z");
const ENV = {
  gatewayUrl: "https://apps.example.com",
  appBaseDomain: "apps.example.com",
};

function specCapability(
  built: ReturnType<typeof mcpStaticProviderSpec>,
): Capability {
  if (!built.ok) throw new Error(built.problem);
  const parsed = parseProviderSpec(built.spec);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
  return parsed.capability;
}

/** The app's own static row, as `mcp add --auth bearer` plans it. */
const tregStatic = specCapability(
  mcpStaticProviderSpec({
    appId: "treg",
    name: "Treg",
    url: "https://treg.to/mcp/",
    kind: "bearer",
  }),
);

const discovery: McpOAuthDiscovery = {
  resource: "https://treg.to/mcp/",
  issuer: "https://auth.treg.to",
  authorizationEndpoint: "https://auth.treg.to/authorize",
  tokenEndpoint: "https://auth.treg.to/token",
  registrationEndpoint: "https://auth.treg.to/register",
  scopes: ["mcp"],
  tokenEndpointAuthMethods: ["client_secret_basic"],
  resourceMetadata: true,
};

const tregOAuth = specCapability(
  mcpOAuthProviderSpec({
    appId: "treg",
    name: "Treg",
    url: "https://treg.to/mcp/",
    discovery,
    client: { hasSecret: true, inject: "basic" },
  }),
);

/** The registry the tests resolve against: the catalog, and `treg-mcp` as `own`. */
function lookup(own: Capability = tregStatic) {
  return (id: string): Capability | undefined =>
    id === "treg-mcp" ? own : (CAPABILITIES as Record<string, Capability>)[id];
}

function input(overrides: Partial<RemoteMcpAddInput> = {}): RemoteMcpAddInput {
  return {
    organizationId: "org-1",
    url: "https://treg.to/mcp/",
    auth: { kind: "provider" },
    lookupProvider: lookup(),
    env: ENV,
    existingApp: () => null,
    actor: "ben@example.com",
    now: NOW,
    ...overrides,
  };
}

function remoteRow(overrides: Partial<AppRow> = {}): AppRow {
  const plan = planRemoteMcpAppAdd(input());
  return { ...plan.app, id: "row-1", ...overrides };
}

const deployedRow: AppRow = {
  id: "row-d",
  organizationId: "org-1",
  appSlug: "treg",
  name: "Treg",
  description: "A deployed app",
  hostname: "treg.apps.example.com",
  workerName: "every-acme-treg",
  tier: "service_binding",
  scope: "org",
  manifest: JSON.stringify({ id: "treg" }),
  status: "active",
  versionId: "v1",
  deployedAt: NOW - 1000,
  deployedByActor: "someone@example.com",
  everyone: false,
};

describe("planRemoteMcpAppAdd", () => {
  it("writes a provider-tier row with the remote block, active, granted to the actor and the owners and admins", () => {
    const plan = planRemoteMcpAppAdd(input());
    expect(plan.kind).toBe("new");
    expect(plan.id).toBe("treg");
    expect(plan.app).toMatchObject({
      organizationId: "org-1",
      appSlug: "treg",
      name: "treg",
      hostname: null,
      workerName: null,
      tier: PROVIDER_APP_TIER,
      scope: "org",
      status: "active",
      versionId: null,
      deployedAt: NOW,
      deployedByActor: "ben@example.com",
      everyone: false,
    });
    expect(remoteMcpOf(JSON.parse(plan.app.manifest!))).toEqual({
      url: "https://treg.to/mcp/",
      auth: { kind: "provider", provider: "treg-mcp" },
      risk: "annotations",
      tools: {},
      rev: 1,
    });
    // The provider is listed as a deployed app lists one.
    expect(JSON.parse(plan.app.manifest!).capabilities).toEqual({
      "treg-mcp": { access: "read", why: expect.any(String) },
    });
    expect(plan.provider).toEqual({ id: "treg-mcp", capability: tregStatic });
    expect(plan).not.toHaveProperty("grants");
    expect(isRemoteMcpRow(plan.app)).toBe(true);
    expect(remoteMcpBlockOf(plan.app)).toEqual(plan.remote);
  });

  it("takes a name, a description, a chosen id, a named provider and a risk default", () => {
    const plan = planRemoteMcpAppAdd(
      input({
        id: "treg-prod",
        name: "Treg (production)",
        description: "Treg's data.",
        auth: { kind: "provider", provider: "treg-mcp" },
        risk: "write",
      }),
    );
    expect(plan.app.name).toBe("Treg (production)");
    expect(plan.app.description).toBe("Treg's data.");
    expect(plan.app.appSlug).toBe("treg-prod");
    expect(plan.remote.auth).toEqual({
      kind: "provider",
      provider: "treg-mcp",
    });
    expect(plan.remote.risk).toBe("write");
  });

  it("writes no provider for a server without a credential", () => {
    const plan = planRemoteMcpAppAdd(input({ auth: { kind: "none" } }));
    expect(plan.remote.auth).toEqual({ kind: "none" });
    expect(plan.provider).toBeNull();
    expect(JSON.parse(plan.app.manifest!).capabilities).toBeUndefined();
    expect(planRemoteMcpAppAdd(input({ auth: undefined })).remote.auth).toEqual(
      { kind: "none" },
    );
  });

  it("lists an OAuth provider with the scopes the connect asks for", () => {
    const own = planRemoteMcpAppAdd(
      input({ lookupProvider: lookup(tregOAuth), scopes: ["mcp"] }),
    );
    expect(own.remote.auth).toEqual({ kind: "provider", provider: "treg-mcp" });
    expect(JSON.parse(own.app.manifest!).capabilities["treg-mcp"]).toEqual({
      scopes: ["mcp"],
      why: expect.any(String),
    });
  });

  it("uses an existing provider on its own host, a reserved one included, and refuses it elsewhere", () => {
    // ElevenLabs' hosted MCP with the catalog's key: the reserved host
    // gives way to the provider that owns it.
    const elevenlabs = CAPABILITIES["elevenlabs" as keyof typeof CAPABILITIES];
    expect(elevenlabs).toBeDefined();
    const plan = planRemoteMcpAppAdd(
      input({
        url: "https://api.elevenlabs.io/v1/mcp",
        auth: { kind: "provider", provider: "elevenlabs" },
      }),
    );
    expect(plan.id).toBe("elevenlabs");
    expect(plan.remote.auth).toEqual({
      kind: "provider",
      provider: "elevenlabs",
    });
    // Without naming it, the host stays refused.
    expect(() =>
      planRemoteMcpAppAdd(
        input({
          url: "https://api.elevenlabs.io/v1/mcp",
          auth: { kind: "none" },
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "REMOTE_MCP_URL_REFUSED" }));
    // The app's own row never opens a reserved host.
    expect(() =>
      planRemoteMcpAppAdd(
        input({
          url: "https://api.elevenlabs.io/v1/mcp",
          id: "treg",
          auth: { kind: "provider" },
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "REMOTE_MCP_URL_REFUSED" }));
    // A provider whose hosts don't include the URL's.
    expect(() =>
      planRemoteMcpAppAdd(
        input({ auth: { kind: "provider", provider: "elevenlabs" } }),
      ),
    ).toThrow(
      expect.objectContaining({
        code: "REMOTE_MCP_PROVIDER_HOST",
        message: expect.stringMatching(
          /^elevenlabs sends its key to .*api\.elevenlabs\.io.*, not to treg\.to$/,
        ),
      }),
    );
  });

  it("refuses a provider it can't find or can't use, and a registration from before providers", () => {
    expect(() =>
      planRemoteMcpAppAdd(
        input({ auth: { kind: "provider", provider: "nope" } }),
      ),
    ).toThrow(
      expect.objectContaining({
        code: "REMOTE_MCP_INVALID",
        message: expect.stringMatching(/no provider nope/),
      }),
    );
    expect(() =>
      planRemoteMcpAppAdd(
        input({ auth: { kind: "provider", provider: "openai" } }),
      ),
    ).toThrow(expect.objectContaining({ code: "REMOTE_MCP_INVALID" }));
    expect(() =>
      planRemoteMcpAppAdd(input({ auth: { kind: "bearer" } })),
    ).toThrow(
      expect.objectContaining({
        code: "REMOTE_MCP_INVALID",
        message: expect.stringMatching(/predates provider credentials/),
      }),
    );
  });

  it("refuses a URL the rules refuse, a bad id and a bad risk", () => {
    expect(() =>
      planRemoteMcpAppAdd(input({ url: "http://treg.to/mcp" })),
    ).toThrow(
      expect.objectContaining({ code: "REMOTE_MCP_URL_REFUSED", status: 400 }),
    );
    expect(() =>
      planRemoteMcpAppAdd(input({ url: "https://apps.example.com/mcp" })),
    ).toThrow(expect.objectContaining({ code: "REMOTE_MCP_URL_REFUSED" }));
    expect(() => planRemoteMcpAppAdd(input({ id: "everyapp" }))).toThrow(
      expect.objectContaining({ code: "REMOTE_MCP_INVALID" }),
    );
    expect(() => planRemoteMcpAppAdd(input({ id: "dataforseo" }))).toThrow(
      expect.objectContaining({
        code: "REMOTE_MCP_INVALID",
        message: expect.stringMatching(/built-in/),
      }),
    );
    expect(() => planRemoteMcpAppAdd(input({ risk: "maybe" }))).toThrow(
      expect.objectContaining({ code: "REMOTE_MCP_INVALID" }),
    );
    expect(() =>
      planRemoteMcpAppAdd(input({ url: "https://1.2.3.4/mcp" })),
    ).toThrow(expect.objectContaining({ code: "REMOTE_MCP_URL_REFUSED" }));
  });

  it("asks for a name when the URL's host gives none", () => {
    expect(() =>
      planRemoteMcpAppAdd(
        input({
          url: "http://localhost:8787/mcp",
          auth: { kind: "none" },
          env: { gatewayUrl: "http://localhost:3000" },
        }),
      ),
    ).toThrow(
      expect.objectContaining({
        code: "REMOTE_MCP_INVALID",
        message: expect.stringMatching(/--name/),
      }),
    );
    const plan = planRemoteMcpAppAdd(
      input({
        url: "http://localhost:8787/mcp",
        id: "fake",
        auth: { kind: "none" },
        env: { gatewayUrl: "http://localhost:3000" },
      }),
    );
    expect(plan.id).toBe("fake");
  });

  it("refuses the id of a deployed app, tombstones included, and of a live remote app", () => {
    expect(() =>
      planRemoteMcpAppAdd(input({ existingApp: () => deployedRow })),
    ).toThrow(
      expect.objectContaining({ code: "APP_TIER_MISMATCH", status: 409 }),
    );
    expect(() =>
      planRemoteMcpAppAdd(
        input({ existingApp: () => ({ ...deployedRow, status: "deleted" }) }),
      ),
    ).toThrow(expect.objectContaining({ code: "APP_TIER_MISMATCH" }));
    expect(() =>
      planRemoteMcpAppAdd(input({ existingApp: () => remoteRow() })),
    ).toThrow(
      expect.objectContaining({
        code: "REMOTE_MCP_EXISTS",
        status: 409,
        message: expect.stringMatching(/\(on\)/),
      }),
    );
    expect(() =>
      planRemoteMcpAppAdd(
        input({ existingApp: () => remoteRow({ status: "disabled" }) }),
      ),
    ).toThrow(
      expect.objectContaining({
        code: "REMOTE_MCP_EXISTS",
        message: expect.stringMatching(/\(off\)/),
      }),
    );
  });

  it("revives its own tombstone as new, under the old row id", () => {
    const tombstone = remoteRow({ status: "deleted", name: "Old" });
    const plan = planRemoteMcpAppAdd(
      input({ existingApp: () => tombstone, name: "Treg" }),
    );
    expect(plan.kind).toBe("revived");
    expect(plan.app.id).toBe("row-1");
    expect(plan.app.status).toBe("active");
    expect(plan.app.name).toBe("Treg");
  });

  it("refuses the id of a shared app every organization sees", () => {
    expect(() =>
      planRemoteMcpAppAdd(
        input({
          sharedApp: () => ({
            ...deployedRow,
            organizationId: "platform",
            scope: "shared",
          }),
        }),
      ),
    ).toThrow(
      expect.objectContaining({
        code: "APP_TIER_MISMATCH",
        message: expect.stringMatching(/shared app/),
      }),
    );
    expect(
      planRemoteMcpAppAdd(
        input({
          sharedApp: () => ({
            ...deployedRow,
            organizationId: "platform",
            scope: "shared",
            status: "deleted",
          }),
        }),
      ).id,
    ).toBe("treg");
  });

  it("continues the revision count when it revives a tombstone", () => {
    const row = remoteRow();
    const edited = remoteMcpAppUpdate(row, { risk: "read" });
    const tombstone = { ...row, manifest: edited.manifest, status: "deleted" };
    const plan = planRemoteMcpAppAdd(input({ existingApp: () => tombstone }));
    expect(plan.kind).toBe("revived");
    expect(plan.remote.rev).toBe(3);
  });

  it("refuses a row of another organization", () => {
    expect(() =>
      planRemoteMcpAppAdd(
        input({ existingApp: () => remoteRow({ organizationId: "org-2" }) }),
      ),
    ).toThrow(/another organization/);
  });
});

describe("remoteMcpAppUpdate", () => {
  it("changes the risk default and one tool's override, and bumps rev", () => {
    const row = remoteRow();
    const first = remoteMcpAppUpdate(row, {
      risk: "read",
      tool: { name: "deleteAll", override: { enabled: false } },
    });
    expect(first.remote).toMatchObject({
      risk: "read",
      tools: { deleteAll: { enabled: false } },
      rev: 2,
    });
    const next = {
      ...row,
      manifest: first.manifest,
      name: first.name,
      description: first.description,
    };
    const second = remoteMcpAppUpdate(next, {
      tool: { name: "deleteAll", override: { risk: "write" } },
    });
    expect(second.remote.tools).toEqual({
      deleteAll: { enabled: false, risk: "write" },
    });
    expect(second.remote.rev).toBe(3);
    const cleared = remoteMcpAppUpdate(
      { ...next, manifest: second.manifest },
      {
        tool: {
          name: "deleteAll",
          override: { enabled: true, risk: undefined },
        },
      },
    );
    expect(cleared.remote.tools).toEqual({});
    const removed = remoteMcpAppUpdate(
      { ...next, manifest: second.manifest },
      { tool: { name: "deleteAll", override: null } },
    );
    expect(removed.remote.tools).toEqual({});
  });

  it("replaces the whole map, renames, and keeps the URL and auth", () => {
    const row = remoteRow();
    const updated = remoteMcpAppUpdate(row, {
      tools: { a: { risk: "read" } },
      name: "Treg",
      description: "Treg's MCP.",
    });
    expect(updated.name).toBe("Treg");
    expect(updated.description).toBe("Treg's MCP.");
    expect(updated.remote).toMatchObject({
      url: "https://treg.to/mcp/",
      auth: { kind: "provider", provider: "treg-mcp" },
      tools: { a: { risk: "read" } },
    });
    const stored = JSON.parse(updated.manifest) as {
      id: string;
      name: string;
      remote: unknown;
    };
    expect(stored.id).toBe("treg");
    expect(stored.name).toBe("Treg");
    // The provider entry is kept as it was written.
    expect((stored as { capabilities?: unknown }).capabilities).toEqual(
      JSON.parse(row.manifest!).capabilities,
    );
  });

  it("keeps rev when nothing about the catalog changed, and refuses an override the block can't hold", () => {
    const row = remoteRow();
    const renamed = remoteMcpAppUpdate(row, { name: "Treg" });
    expect(renamed.remote.rev).toBe(1);
    const same = remoteMcpAppUpdate(row, { risk: "annotations", tools: {} });
    expect(same.remote.rev).toBe(1);
    expect(() =>
      remoteMcpAppUpdate(row, { tools: { bad: { risk: "nuke" as never } } }),
    ).toThrow(expect.objectContaining({ code: "REMOTE_MCP_INVALID" }));
    expect(() =>
      remoteMcpAppUpdate(row, {
        tool: { name: "x", override: { enabled: "no" as never } },
      }),
    ).toThrow(expect.objectContaining({ code: "REMOTE_MCP_INVALID" }));
  });

  it("refuses a bad risk, a tombstone, and a row that isn't a remote app's", () => {
    expect(() => remoteMcpAppUpdate(remoteRow(), { risk: "maybe" })).toThrow(
      expect.objectContaining({ code: "REMOTE_MCP_INVALID" }),
    );
    expect(() =>
      remoteMcpAppUpdate(remoteRow({ status: "deleted" }), { risk: "read" }),
    ).toThrow(expect.objectContaining({ code: "APP_NOT_FOUND" }));
    expect(() => remoteMcpAppUpdate(deployedRow, { risk: "read" })).toThrow(
      expect.objectContaining({ code: "APP_NOT_FOUND" }),
    );
  });
});

describe("mcpAppStatusUpdate and mcpAppRemoveUpdate", () => {
  it("turns a remote or built-in MCP app off and on, and does nothing twice", () => {
    expect(mcpAppStatusUpdate(remoteRow(), "disabled")).toEqual({
      status: "disabled",
    });
    expect(
      mcpAppStatusUpdate(remoteRow({ status: "disabled" }), "active"),
    ).toEqual({ status: "active" });
    expect(mcpAppStatusUpdate(remoteRow(), "active")).toBeNull();
    const builtIn = planProviderAppOn({
      organizationId: "org-1",
      id: "dataforseo",
      existingApp: null,
      actor: "ben@example.com",
      now: NOW,
    }).app;
    expect(mcpAppStatusUpdate(builtIn, "disabled")).toEqual({
      status: "disabled",
    });
    // `mcp on` for a built-in that is off serves it again.
    const again = planProviderAppOn({
      organizationId: "org-1",
      id: "dataforseo",
      existingApp: { ...builtIn, status: "disabled" },
      actor: "ben@example.com",
      now: NOW,
    });
    expect(again.kind).toBe("existing");
    expect(again.app.status).toBe("active");
  });

  it("refuses a deployed app's row and a tombstone", () => {
    expect(() => mcpAppStatusUpdate(deployedRow, "disabled")).toThrow(
      expect.objectContaining({ code: "APP_TIER_MISMATCH" }),
    );
    expect(() =>
      mcpAppStatusUpdate(remoteRow({ status: "deleted" }), "active"),
    ).toThrow(expect.objectContaining({ code: "APP_NOT_FOUND" }));
  });

  it("removes an MCP app of either kind as a tombstone and never a deployed app", () => {
    expect(mcpAppRemoveUpdate(remoteRow())).toEqual({
      status: "deleted",
      everyone: false,
      emailSenders: null,
      emailInbound: null,
      secretNames: null,
    });
    expect(mcpAppRemoveUpdate(remoteRow({ status: "disabled" }))).toMatchObject(
      { status: "deleted" },
    );
    expect(mcpAppRemoveUpdate(remoteRow({ status: "deleted" }))).toBeNull();
    expect(mcpAppRemoveUpdate(deployedRow)).toBeNull();
    expect(mcpAppRemoveUpdate(null)).toBeNull();
  });
});

describe("planRemoteMcpProviderRow", () => {
  const staticSpec = mcpStaticProviderSpec({
    appId: "treg",
    name: "Treg",
    url: "https://treg.to/mcp/",
    kind: "bearer",
  });
  if (!staticSpec.ok) throw new Error(staticSpec.problem);

  it("inserts the app's own row, and keeps a row with the same spec, bound or not", () => {
    const insert = planRemoteMcpProviderRow({
      appId: "treg",
      spec: staticSpec.spec,
      existing: null,
    });
    expect(insert).toMatchObject({
      action: "insert",
      id: "treg-mcp",
      bound: false,
      bindingKey: providerBindingKey(tregStatic as never),
    });
    expect(JSON.parse(insert.spec)).toEqual(staticSpec.spec);
    const keep = planRemoteMcpProviderRow({
      appId: "treg",
      spec: staticSpec.spec,
      existing: {
        id: "treg-mcp",
        spec: JSON.stringify(staticSpec.spec),
        boundTo: insert.bindingKey,
      },
    });
    expect(keep).toMatchObject({ action: "keep", bound: true });
  });

  it("replaces a row whose spec differs; a moved credential unbinds, a renamed one doesn't", () => {
    const header = mcpStaticProviderSpec({
      appId: "treg",
      name: "Treg",
      url: "https://treg.to/mcp/",
      kind: "header",
      header: "X-Api-Key",
    });
    if (!header.ok) throw new Error(header.problem);
    const bound = planRemoteMcpProviderRow({
      appId: "treg",
      spec: staticSpec.spec,
      existing: null,
    }).bindingKey;
    const moved = planRemoteMcpProviderRow({
      appId: "treg",
      spec: header.spec,
      existing: {
        id: "treg-mcp",
        spec: JSON.stringify(staticSpec.spec),
        boundTo: bound,
      },
    });
    expect(moved).toMatchObject({ action: "replace", bound: false });
    const renamed = planRemoteMcpProviderRow({
      appId: "treg",
      spec: { ...staticSpec.spec, name: "Treg two MCP server" },
      existing: {
        id: "treg-mcp",
        spec: JSON.stringify(staticSpec.spec),
        boundTo: bound,
      },
    });
    expect(renamed).toMatchObject({ action: "replace", bound: true });
  });

  it("refuses a hand-registered row of that id, and a spec the registry refuses", () => {
    expect(() =>
      planRemoteMcpProviderRow({
        appId: "treg",
        spec: staticSpec.spec,
        existing: {
          id: "treg-mcp",
          spec: JSON.stringify({ ...staticSpec.spec, tags: [] }),
        },
      }),
    ).toThrow(
      expect.objectContaining({
        code: "REMOTE_MCP_INVALID",
        message: expect.stringMatching(/registered by hand/),
      }),
    );
    expect(() =>
      planRemoteMcpProviderRow({
        appId: "treg",
        spec: staticSpec.spec,
        existing: null,
        refuseHost: (host) =>
          host === "treg.to" ? "treg.to is this gateway's own host" : null,
      }),
    ).toThrow(expect.objectContaining({ code: "REMOTE_MCP_URL_REFUSED" }));
    expect(() =>
      planRemoteMcpProviderRow({
        appId: "treg",
        spec: staticSpec.spec,
        existing: null,
        rowSettings: new Set(["TREG_MCP_TOKEN"]),
      }),
    ).toThrow(expect.objectContaining({ code: "REMOTE_MCP_INVALID" }));
  });

  it("is a row the registry serves, its token setting the row's own", () => {
    const registry = providerRegistry([
      { id: "treg-mcp", spec: JSON.stringify(staticSpec.spec) },
    ]);
    expect(registry.rejected).toEqual([]);
    expect(registry.settingNames().has("TREG_MCP_TOKEN")).toBe(true);
    expect(registry.bound("treg-mcp")).toBe(false);
  });
});

describe("isMeteredAppRow", () => {
  it("meters deployed and built-in MCP apps, never a remote MCP app", () => {
    expect(isMeteredAppRow(deployedRow)).toBe(true);
    const builtIn = planProviderAppOn({
      organizationId: "org-1",
      id: "dataforseo",
      existingApp: null,
      actor: "ben@example.com",
      now: NOW,
    }).app;
    expect(isMeteredAppRow(builtIn)).toBe(true);
    expect(isMeteredAppRow(remoteRow())).toBe(false);
    // An unreadable registration (from before provider credentials) neither.
    expect(
      isMeteredAppRow(
        remoteRow({
          manifest: JSON.stringify({
            id: "treg",
            remote: {
              url: "https://treg.to/mcp/",
              auth: { kind: "bearer", secret: "TREG_MCP_TOKEN" },
            },
          }),
        }),
      ),
    ).toBe(false);
    expect(appNotMeteredMessage("Treg")).toBe(
      "Treg is an MCP server added by URL; it isn't metered, so it takes no cap.",
    );
  });
});
