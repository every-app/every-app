/**
 * The gateway's registry over registered rows: the host rule this gateway
 * adds (its own host, its app domain, its third-party domain), the
 * key-binding rule as the proxy and the setup gate read it
 * (`providers.value-bound-to-hosts`), and the catalog as the fallback when
 * the rows can't be read.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  providerBindingKey,
  providerRegistry,
  type ProviderRow,
} from "@every-app/sdk/internal";

// The modules under test read the Worker env; this test passes its own.
vi.mock("cloudflare:workers", () => ({
  env: {},
  waitUntil: () => undefined,
  WorkerEntrypoint: class {},
}));
import { appSettingsReport } from "../app-setup";
import { handleIntegrationProxyRequest } from "../integration-proxy";
import { refusedGatewayHost, registryFromRows } from "./index";

const SETTINGS = {
  GATEWAY_URL: "https://apps.example.com",
  APP_BASE_DOMAIN: "apps.example.com",
  THIRD_PARTY_DOMAIN: "third-party.net",
  GATEWAY_DEPLOYMENT_MODE: "self_hosted",
};

const spec = {
  id: "stripe",
  name: "Stripe",
  docs: "https://dashboard.stripe.com/apikeys",
  hosts: ["api.stripe.com"],
  auth: { kind: "bearer", secret: "STRIPE_API_KEY" },
};

/** The row as `everyapp secret set` leaves it: bound to the hosts it has. */
function boundRow(overrides: Partial<ProviderRow> = {}): ProviderRow {
  const registry = providerRegistry([{ id: "stripe", spec }]);
  const [row] = registry.rows();
  return {
    id: "stripe",
    spec,
    boundTo: providerBindingKey(row!.capability),
    addedBy: "ben@example.com",
    addedAt: 1,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the gateway's host rule", () => {
  it("refuses its own host and anything under its app and third-party domains", () => {
    expect(refusedGatewayHost("apps.example.com", SETTINGS)).toContain(
      "own host",
    );
    expect(refusedGatewayHost("crm.apps.example.com", SETTINGS)).toContain(
      "app domain",
    );
    // A third-party domain exists on a hosted gateway only.
    expect(
      refusedGatewayHost("x.third-party.net", {
        ...SETTINGS,
        GATEWAY_DEPLOYMENT_MODE: "hosted",
      }),
    ).toContain("third-party domain");
    expect(refusedGatewayHost("x.third-party.net", SETTINGS)).toBeNull();
    expect(refusedGatewayHost("api.stripe.com", SETTINGS)).toBeNull();
    // A gateway with none set refuses nothing of its own.
    expect(refusedGatewayHost("apps.example.com", {})).toBeNull();
  });

  it("drops a row on such a host, logging the id and the reason once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = [
      {
        id: "evil",
        spec: {
          ...spec,
          id: "evil",
          hosts: ["crm.apps.example.com"],
          auth: { kind: "bearer", secret: "EVIL_KEY" },
        },
      },
    ];
    expect(registryFromRows(rows, SETTINGS).get("evil")).toBeUndefined();
    registryFromRows(rows, SETTINGS);
    const lines = warn.mock.calls
      .map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>)
      .filter((entry) => entry["evt"] === "provider.row_invalid");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      provider: "evil",
      reason: "PROVIDER_HOST_REFUSED",
    });
    expect(JSON.stringify(lines[0])).not.toContain("EVIL_KEY");
  });
});

describe("the key-binding rule", () => {
  const env = { ...SETTINGS, STRIPE_API_KEY: "sk_live" };

  async function callStripe(rows: ProviderRow[]) {
    const lookup = registryFromRows(rows, SETTINGS);
    let upstream: Request | undefined;
    const response = await handleIntegrationProxyRequest({
      request: new Request(
        "http://every-app-gateway.internal/api/integrations/stripe/api.stripe.com/v1/balance",
      ),
      capabilities: { stripe: { access: "read" } },
      lookup,
      env,
      admit: async () => ({
        caller: {
          organizationId: "org-1",
          appId: "shop",
          worker: "every-shop",
          orgSource: "props",
        },
        user: null,
      }),
      fetchUpstream: async (request) => {
        upstream = request;
        return Response.json({ ok: true });
      },
      listMembers: async () => {
        throw new Error("not a service");
      },
    });
    return { response, upstream, lookup };
  }

  it("reads the key for a row bound to the hosts it has, and not after the hosts change", async () => {
    const bound = await callStripe([boundRow()]);
    expect(bound.response.status).toBe(200);
    expect(bound.upstream?.headers.get("authorization")).toBe("Bearer sk_live");

    // The row replaced with another host while the key stays set.
    const replaced = await callStripe([
      boundRow({
        spec: { ...spec, hosts: ["api.stripe.com", "attacker.example"] },
      }),
    ]);
    expect(replaced.lookup.bound("stripe")).toBe(false);
    expect(replaced.response.status).toBe(503);
    await expect(replaced.response.json()).resolves.toMatchObject({
      code: "integration_not_configured",
      message: expect.stringContaining("set for other hosts"),
    });
    expect(replaced.upstream).toBeUndefined();

    // Never bound: a row added and not yet given a key.
    const fresh = await callStripe([boundRow({ boundTo: null })]);
    expect(fresh.response.status).toBe(503);
    expect(fresh.upstream).toBeUndefined();
  });

  it("answers an unbound row's status as not configured, and its app as needing setup", async () => {
    const lookup = registryFromRows([boundRow({ boundTo: null })], SETTINGS);
    const status = await handleIntegrationProxyRequest({
      request: new Request(
        "http://every-app-gateway.internal/api/integrations/stripe",
      ),
      capabilities: { stripe: { access: "read" } },
      lookup,
      env,
      admit: async () => {
        throw new Error("never admitted");
      },
      listMembers: async () => {
        throw new Error("not a service");
      },
    });
    await expect(status.json()).resolves.toEqual({
      capability: "stripe",
      requested: true,
      configured: false,
      ready: false,
    });

    const report = await appSettingsReport(
      {
        rowId: "row-1",
        versionId: "v1",
        secretNames: [],
        appId: "shop",
        tier: "service_binding",
        manifest: { capabilities: { stripe: { access: "read" } } },
        canFix: true,
      },
      {
        settings: env,
        emailConfigured: async () => true,
        providers: async () => lookup,
      },
    );
    expect(report?.ready).toBe(false);
    expect(report?.unmet.map((setting) => setting.id)).toEqual(["stripe"]);

    const boundReport = await appSettingsReport(
      {
        rowId: "row-1",
        versionId: "v1",
        secretNames: [],
        appId: "shop",
        tier: "service_binding",
        manifest: { capabilities: { stripe: { access: "read" } } },
        canFix: true,
      },
      {
        settings: env,
        emailConfigured: async () => true,
        providers: async () => registryFromRows([boundRow()], SETTINGS),
      },
    );
    expect(boundReport?.ready).toBe(true);
  });
});
