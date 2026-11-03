import { describe, expect, it } from "vitest";
import { PROVIDER_APP_TIER } from "@every-app/sdk/internal";
import {
  planProviderAppOn,
  providerAppId,
  providerAppOffUpdate,
  type ProviderAppInput,
} from "./providerApps";
import { planRegistration, type AppRow } from "./registration";

const NOW = Date.parse("2026-10-24T12:00:00Z");

const input: ProviderAppInput = {
  organizationId: "org-1",
  id: "dataforseo",
  existingApp: null,
  actor: "ben@example.com",
  now: NOW,
};

const onRow: AppRow = {
  id: "row-1",
  organizationId: "org-1",
  appSlug: "dataforseo",
  name: "Old name",
  description: "Old description",
  hostname: null,
  workerName: null,
  tier: PROVIDER_APP_TIER,
  scope: "org",
  manifest: "{}",
  status: "active",
  versionId: null,
  deployedAt: NOW - 1000,
  deployedByActor: "someone@example.com",
  everyone: false,
};

const deployedRow: AppRow = {
  ...onRow,
  hostname: "dataforseo.apps.example.com",
  workerName: "every-acme-dataforseo",
  tier: "service_binding",
};

describe("providerAppId", () => {
  it("names the MCP apps there are for an unknown id", () => {
    expect(() => providerAppId("ahrefs")).toThrow(
      expect.objectContaining({
        code: "PROVIDER_APP_UNKNOWN",
        status: 400,
        message: '"ahrefs" is not an MCP app. The Gateway offers: dataforseo.',
      }),
    );
  });
});

describe("planProviderAppOn", () => {
  it("writes a new active row with no Worker, the generated manifest, open to owners and admins", () => {
    const plan = planProviderAppOn(input);
    expect(plan.kind).toBe("new");
    expect(plan.app).toMatchObject({
      organizationId: "org-1",
      appSlug: "dataforseo",
      name: "DataForSEO",
      hostname: null,
      workerName: null,
      tier: "provider",
      scope: "org",
      status: "active",
      versionId: null,
      deployedAt: NOW,
      deployedByActor: "ben@example.com",
      everyone: false,
    });
    expect(JSON.parse(plan.app.manifest!)).toEqual({
      id: "dataforseo",
      name: "DataForSEO",
      description: expect.stringContaining("SEO data"),
      capabilities: {
        dataforseo: {
          access: "read",
          why: expect.stringContaining("DataForSEO"),
        },
      },
    });
    expect(plan).not.toHaveProperty("grants");
  });

  it("keeps an app that is on, updating only its name and description", () => {
    const plan = planProviderAppOn({ ...input, existingApp: onRow });
    expect(plan.kind).toBe("existing");
    expect(plan.app).toMatchObject({
      id: "row-1",
      name: "DataForSEO",
      status: "active",
      deployedByActor: "someone@example.com",
    });
  });

  it("revives its own tombstone as new, under the same row id", () => {
    const plan = planProviderAppOn({
      ...input,
      existingApp: { ...onRow, status: "deleted" },
    });
    expect(plan.kind).toBe("revived");
    expect(plan.app).toMatchObject({
      id: "row-1",
      status: "active",
      deployedByActor: "ben@example.com",
    });
  });

  it("refuses the id of a deployed app, tombstones included", () => {
    expect(() =>
      planProviderAppOn({ ...input, existingApp: deployedRow }),
    ).toThrow(
      expect.objectContaining({
        code: "APP_TIER_MISMATCH",
        status: 409,
        message:
          '"dataforseo" is an app deployed to this Gateway, not the MCP app; the MCP app can\'t take its id.',
      }),
    );
    expect(() =>
      planProviderAppOn({
        ...input,
        existingApp: { ...deployedRow, status: "deleted" },
      }),
    ).toThrow(expect.objectContaining({ code: "APP_TIER_MISMATCH" }));
  });

  it("refuses an unknown provider", () => {
    expect(() => planProviderAppOn({ ...input, id: "ahrefs" })).toThrow(
      expect.objectContaining({ code: "PROVIDER_APP_UNKNOWN" }),
    );
  });
});

describe("providerAppOffUpdate", () => {
  it("tombstones an MCP app that is on", () => {
    expect(providerAppOffUpdate("dataforseo", onRow)).toEqual({
      status: "deleted",
      everyone: false,
      emailSenders: null,
      emailInbound: null,
      secretNames: null,
    });
  });

  it("writes nothing for no row, a tombstone, or a deployed app's row", () => {
    expect(providerAppOffUpdate("dataforseo", null)).toBeNull();
    expect(
      providerAppOffUpdate("dataforseo", { ...onRow, status: "deleted" }),
    ).toBeNull();
    expect(providerAppOffUpdate("dataforseo", deployedRow)).toBeNull();
  });
});

describe("planRegistration against an MCP app's row", () => {
  it("refuses to deploy an app under the MCP app's id", () => {
    expect(() =>
      planRegistration({
        organizationId: "org-1",
        isInstallOrganization: true,
        appSlug: "dataforseo",
        name: "DataForSEO clone",
        description: "",
        manifest: { id: "dataforseo" },
        appBaseDomain: "apps.example.com",
        orgKey: "acme",
        existingApp: onRow,
        hostnameOwner: null,
        workerNameOwner: null,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "APP_TIER_MISMATCH",
        message:
          '"dataforseo" is the Gateway\'s MCP app of that name; give this app an id of its own.',
      }),
    );
  });
});
