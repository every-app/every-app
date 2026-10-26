import { describe, expect, it, vi } from "vitest";
import { ORG_HEADER } from "../internal/index";
import { AttributionError, type GatewayCallFor } from "./attribution";
import { RequestContextError, serveRequest, withOrganization } from "./context";
import { createGatewayFetch } from "./gatewayFetch";
import { integrationFetch } from "./integrationFetch";

function binding() {
  return vi.fn<(request: Request) => Promise<Response>>(async () =>
    Response.json({ ok: true }),
  );
}

const inbound = () =>
  new Request("https://openseo.example.com/_serverFn/x", {
    headers: { "x-everyapp-identity": "signed-user-identity" },
  });

/** Both helpers, built the same way, so every rule is checked for each. */
const helpers = {
  integrationFetch: (env: object, target?: GatewayCallFor) =>
    integrationFetch({ env, provider: "dataforseo", for: target }),
  createGatewayFetch: (env: object, target?: GatewayCallFor) =>
    createGatewayFetch({ env, for: target }),
};
const urls = {
  integrationFetch: "https://api.dataforseo.com/v3/appendix/status",
  createGatewayFetch: "https://gateway.example.com/api/ai/openai/v1/responses",
};

describe.each(Object.keys(helpers) as Array<keyof typeof helpers>)(
  "%s attribution",
  (name) => {
    const make = helpers[name];
    const url = urls[name];

    it("forwards the request's identity and never an organization the app set", async () => {
      const fetch = binding();
      await make({ EVERY_APP_GATEWAY: { fetch } }, inbound())(url, {
        headers: { [ORG_HEADER]: "org-other" },
      });
      const sent = fetch.mock.calls[0]![0];
      expect(sent.headers.get("x-everyapp-identity")).toBe(
        "signed-user-identity",
      );
      expect(sent.headers.get(ORG_HEADER)).toBeNull();
    });

    it("sends background work's organization and no identity", async () => {
      const fetch = binding();
      await make(
        { EVERY_APP_GATEWAY: { fetch }, EVERYAPP_SHARED: "1" },
        { background: true, organizationId: "org-acme" },
      )(url, { headers: { "x-everyapp-identity": "app-supplied" } });
      const sent = fetch.mock.calls[0]![0];
      expect(sent.headers.get(ORG_HEADER)).toBe("org-acme");
      expect(sent.headers.get("x-everyapp-identity")).toBeNull();
    });

    it("refuses a shared Worker's call that says nobody, before calling", () => {
      const fetch = binding();
      const env = { EVERY_APP_GATEWAY: { fetch }, EVERYAPP_SHARED: "1" };
      // Background work with no organization named.
      expect(() => make(env, { background: true })).toThrowError(
        AttributionError,
      );
      expect(() => make(env, { background: true })).toThrow(/organizationId/);
      // A public route's request: no person, and no organization to name.
      const served = {
        request: new Request("https://app.example.com/public"),
        user: null,
        expiresAt: null,
      };
      expect(() => serveRequest(served, () => make(env))).toThrowError(
        AttributionError,
      );
      expect(fetch).not.toHaveBeenCalled();
    });

    it("refuses any Worker's call with no `for` outside every context, before calling", () => {
      const fetch = binding();
      const env = { EVERY_APP_GATEWAY: { fetch }, EVERY_APP_ORG_ID: "org-1" };
      expect(() => make(env)).toThrowError(RequestContextError);
      expect(() => make(env)).toThrow(/withOrganization/);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("lets an organization's own app send background work as the app's", async () => {
      const fetch = binding();
      const env = { EVERY_APP_GATEWAY: { fetch }, EVERY_APP_ORG_ID: "org-1" };
      await make(env, { background: true })(url);
      const [sent] = fetch.mock.calls[0]!;
      expect(sent.headers.get(ORG_HEADER)).toBeNull();
      expect(sent.headers.get("x-everyapp-identity")).toBeNull();
    });

    it("names withOrganization()'s organization for a call with no `for`", async () => {
      const fetch = binding();
      const env = { EVERY_APP_GATEWAY: { fetch }, EVERYAPP_SHARED: "1" };
      await withOrganization("org-acme", () => make(env)(url));
      const [sent] = fetch.mock.calls[0]!;
      expect(sent.headers.get(ORG_HEADER)).toBe("org-acme");
      expect(sent.headers.get("x-everyapp-identity")).toBeNull();
    });

    it("refuses a `for` that is neither a request nor background work", () => {
      const env = { EVERY_APP_GATEWAY: { fetch: binding() } };
      expect(() =>
        make(env, { background: false } as unknown as GatewayCallFor),
      ).toThrowError(AttributionError);
      expect(() =>
        make(env, { background: true, organizationId: " " }),
      ).toThrowError(AttributionError);
    });
  },
);
