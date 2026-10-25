import { describe, expect, it } from "vitest";
import { PROVIDER_APP_TIER, remoteMcpOf } from "@every-app/sdk/internal";
import {
  isRemoteMcpRow,
  mcpAppRemoveUpdate,
  mcpAppStatusUpdate,
  planRemoteMcpAppAdd,
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

const members = [
  { id: "owner", role: "owner" },
  { id: "admin", role: "admin" },
  { id: "member", role: "member" },
  { id: "actor", role: "member" },
];

function input(overrides: Partial<RemoteMcpAddInput> = {}): RemoteMcpAddInput {
  return {
    organizationId: "org-1",
    url: "https://treg.to/mcp/",
    auth: { kind: "bearer" },
    env: ENV,
    existingApp: () => null,
    members,
    actorUserId: "actor",
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
  isDefault: false,
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
      isDefault: false,
    });
    expect(remoteMcpOf(JSON.parse(plan.app.manifest!))).toEqual({
      url: "https://treg.to/mcp/",
      auth: { kind: "bearer", secret: "TREG_MCP_TOKEN" },
      risk: "annotations",
      tools: {},
      rev: 1,
    });
    expect(plan.grants.map((grant) => grant.userId).sort()).toEqual([
      "actor",
      "admin",
      "owner",
    ]);
    expect(isRemoteMcpRow(plan.app)).toBe(true);
    expect(remoteMcpBlockOf(plan.app)).toEqual(plan.remote);
  });

  it("takes a name, a description, a chosen id, a chosen secret name and a risk default", () => {
    const plan = planRemoteMcpAppAdd(
      input({
        id: "treg-prod",
        name: "Treg (production)",
        description: "Treg's data.",
        auth: {
          kind: "header",
          secret: "TREG_SHARED_MCP_TOKEN",
          header: "X-Api-Key",
        },
        risk: "write",
      }),
    );
    expect(plan.app.name).toBe("Treg (production)");
    expect(plan.app.description).toBe("Treg's data.");
    expect(plan.app.appSlug).toBe("treg-prod");
    expect(plan.remote.auth).toEqual({
      kind: "header",
      secret: "TREG_SHARED_MCP_TOKEN",
      header: "X-Api-Key",
    });
    expect(plan.remote.risk).toBe("write");
  });

  it("refuses a URL the rules refuse, a bad id, a foreign secret name and a bad risk", () => {
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
    expect(() =>
      planRemoteMcpAppAdd(
        input({ auth: { kind: "bearer", secret: "OPENAI_API_KEY" } }),
      ),
    ).toThrow(
      expect.objectContaining({
        code: "REMOTE_MCP_INVALID",
        message: expect.stringMatching(/_MCP_TOKEN/),
      }),
    );
    expect(() => planRemoteMcpAppAdd(input({ risk: "maybe" }))).toThrow(
      expect.objectContaining({ code: "REMOTE_MCP_INVALID" }),
    );
    expect(() =>
      planRemoteMcpAppAdd(input({ url: "https://1.2.3.4/mcp" })),
    ).toThrow(expect.objectContaining({ code: "REMOTE_MCP_URL_REFUSED" }));
  });

  it("refuses a credential name another MCP app sends to a different origin", () => {
    expect(() =>
      planRemoteMcpAppAdd(
        input({ secretUsedAt: () => "https://other.example" }),
      ),
    ).toThrow(
      expect.objectContaining({ code: "REMOTE_MCP_SECRET_TAKEN", status: 409 }),
    );
    expect(
      planRemoteMcpAppAdd(input({ secretUsedAt: () => "https://treg.to" })).id,
    ).toBe("treg");
    expect(planRemoteMcpAppAdd(input({ secretUsedAt: () => null })).id).toBe(
      "treg",
    );
  });

  it("asks for a name when the URL's host gives none", () => {
    expect(() =>
      planRemoteMcpAppAdd(
        input({
          url: "http://localhost:8787/mcp",
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

  it("revives its own tombstone as new, under the old row id, with fresh grants", () => {
    const tombstone = remoteRow({ status: "deleted", name: "Old" });
    const plan = planRemoteMcpAppAdd(
      input({ existingApp: () => tombstone, name: "Treg" }),
    );
    expect(plan.kind).toBe("revived");
    expect(plan.app.id).toBe("row-1");
    expect(plan.app.status).toBe("active");
    expect(plan.app.name).toBe("Treg");
    expect(plan.grants).toHaveLength(3);
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
      tool: { name: "deleteAll", override: { risk: "destructive" } },
    });
    expect(second.remote.tools).toEqual({
      deleteAll: { enabled: false, risk: "destructive" },
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
      auth: { kind: "bearer", secret: "TREG_MCP_TOKEN" },
      tools: { a: { risk: "read" } },
    });
    const stored = JSON.parse(updated.manifest) as {
      id: string;
      name: string;
      remote: unknown;
    };
    expect(stored.id).toBe("treg");
    expect(stored.name).toBe("Treg");
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
      members,
      actorUserId: "actor",
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
      members,
      actorUserId: "actor",
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
      isDefault: false,
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
