import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  CAPABILITY_IDS,
  integrationProxyPath,
  isCapabilityId,
  parseIntegrationProxyPath,
} from "./capabilities";

describe("integration proxy paths", () => {
  it("round-trips a provider URL", () => {
    const upstream = new URL(
      "https://api.dataforseo.com/v3/serp/google/organic/task_get/advanced/abc?x=1",
    );
    const url = new URL(
      integrationProxyPath("dataforseo", upstream),
      "http://gateway.internal",
    );

    expect(parseIntegrationProxyPath(url.pathname, url.search)).toEqual({
      id: "dataforseo",
      upstream,
    });
  });

  it.each([
    ["an unknown provider", "/api/integrations/github/api.github.com/user"],
    [
      "a host outside the provider's",
      "/api/integrations/dataforseo/evil.example/v3/x",
    ],
    [
      "a host with a port",
      "/api/integrations/dataforseo/api.dataforseo.com:8443/v3/x",
    ],
    [
      "a protocol-relative path",
      "/api/integrations/dataforseo/api.dataforseo.com//evil.example/x",
    ],
  ])("rejects %s", (_name, pathname) => {
    expect(parseIntegrationProxyPath(pathname, "")).toBeNull();
  });
});

describe("DataForSEO credentials", () => {
  const { authorization } = CAPABILITIES.dataforseo;

  it("encodes a login:password key", () => {
    expect(authorization("me@example.com:secret")).toBe(
      `Basic ${btoa("me@example.com:secret")}`,
    );
  });

  it("keeps a key that is already base64", () => {
    expect(authorization(` ${btoa("me@example.com:secret")} `)).toBe(
      `Basic ${btoa("me@example.com:secret")}`,
    );
  });
});

describe("Context.dev credentials", () => {
  it("sends the key as a bearer token", () => {
    expect(CAPABILITIES.context.authorization(" ctx_key ")).toBe(
      "Bearer ctx_key",
    );
  });
});

describe("the capability registry", () => {
  it.each(CAPABILITY_IDS)(
    "%s sends its key only to https hosts and reads only with read methods",
    (id) => {
      const capability = CAPABILITIES[id];
      expect(capability.hosts.length).toBeGreaterThan(0);
      for (const host of capability.hosts) {
        expect(new URL(`https://${host}`).host).toBe(host);
      }
      expect(capability.access).toContain("read");
      expect(capability.readMethods).not.toContain("DELETE");
    },
  );

  it("knows only its own ids", () => {
    expect(isCapabilityId("dataforseo")).toBe(true);
    expect(isCapabilityId("toString")).toBe(false);
    expect(isCapabilityId("openai")).toBe(false);
  });
});
