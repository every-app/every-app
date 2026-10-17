import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CAPABILITIES,
  CAPABILITY_IDS,
  capabilitySettings,
  integrationProxyPath,
  isAccountWidePath,
  isCapabilityId,
  parseIntegrationProxyPath,
  serviceRoutePath,
  type ApiKeyCapabilityId,
  type Capability,
  type CapabilitySecret,
  type ServiceCapabilityId,
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
      kind: "api_key",
      id: "dataforseo",
      upstream,
    });
  });

  it("names a service capability's declared route", () => {
    expect(serviceRoutePath("email", "send")).toBe(
      "/api/integrations/email/send",
    );
    expect(
      parseIntegrationProxyPath("/api/integrations/email/send", ""),
    ).toEqual({ kind: "service", id: "email", route: "send" });
    // A query string doesn't change the route.
    expect(
      parseIntegrationProxyPath("/api/integrations/email/send", "?x=1"),
    ).toEqual({ kind: "service", id: "email", route: "send" });
  });

  it.each([
    ["a route email doesn't declare", "/api/integrations/email/other"],
    ["a path under the route", "/api/integrations/email/send/more"],
    ["a trailing slash", "/api/integrations/email/send/"],
    ["an inherited property", "/api/integrations/email/toString"],
    ["a host-shaped route", "/api/integrations/email/api.cloudflare.com/x"],
  ])("refuses %s", (_name, pathname) => {
    expect(parseIntegrationProxyPath(pathname, "")).toBeNull();
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

describe("DataForSEO's account-wide paths", () => {
  /** The pathname the gateway checks: what the URL parser leaves of `path`. */
  const accountWide = (path: string) =>
    isAccountWidePath(
      CAPABILITIES.dataforseo,
      new URL(`https://api.dataforseo.com${path}`).pathname,
    );

  it.each([
    "/v3/serp/google/organic/tasks_ready",
    "/v3/dataforseo_labs/id_list",
    "/v3/appendix/errors",
    "/v3/appendix/user_data",
    "/v3/appendix/webhook_resend",
    // A suffix on the segment: whitespace, NUL, a comma, raw or encoded.
    "/v3/serp/google/organic/tasks_ready%20",
    "/v3/serp/google/organic/tasks_ready%00",
    "/v3/serp/google/organic/tasks_ready,",
    "/v3/serp/google/organic/tasks_ready%2C",
    "/v3/serp/google/organic/tasks_ready%2c/advanced",
    "/v3/serp/id_list;x",
    "/v3/serp/id_list.json",
    "/v3/serp/id_list%09",
    "/v3/serp/id_list%E2%80%8B",
    // Encoded, twice-encoded or in another case.
    "/v3/serp/google/organic/tasks%5Fready",
    "/v3/serp/google/organic/tasks%255Fready",
    "/v3/serp/google/organic/TASKS_READY",
    // Case folding outside ASCII is the provider's: ſ is an s to some.
    "/v3/serp/google/organic/ta%C5%BFks_ready",
    // The multi-segment ones, split or suffixed.
    "/v3/appendix%2Fuser_data",
    "/v3/appendix//user_data",
    "/v3/appendix%5Cwebhook_resend",
    "/v3/APPENDIX/user_data%20",
    "/v3/appendix;x/webhook_resend,",
    // A dot segment only decoding reveals.
    "/v3/serp/tasks_ready/%252e%252e",
    // Won't decode, or won't stop decoding.
    "/v3/serp/%E0%A4%A",
    "/v3/serp/google/organic/%2525252574asks_ready",
  ])("refuses %s", (path) => {
    expect(accountWide(path)).toBe(true);
  });

  it.each([
    "/v3/serp/google/organic/task_get/advanced/09271234-1535-0066-0000-5c2f2a1f8d10",
    "/v3/serp/google/organic/task_post",
    "/v3/serp/google/organic/live/advanced",
    "/v3/serp/google/organic/tasks_fixed",
    "/v3/dataforseo_labs/google/keyword_ideas/live",
    "/v3/appendix/status",
    "/v3/appendix/user_data_example",
    "/v3/user_data",
    "/v3/serp/google/locations/us",
  ])("serves %s", (path) => {
    expect(accountWide(path)).toBe(false);
  });

  it("refuses whitespace and control characters for providers without account-wide paths too", () => {
    expect(isAccountWidePath(CAPABILITIES.context, "/v1/scrape")).toBe(false);
    expect(isAccountWidePath(CAPABILITIES.context, "/v1/scrape%0A")).toBe(true);
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
  const apiKeyIds = CAPABILITY_IDS.filter(
    (id): id is ApiKeyCapabilityId => CAPABILITIES[id].mode === "api_key",
  );

  it.each(apiKeyIds)(
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

  it("offers email as a service the gateway performs, write only", () => {
    const email: Capability = CAPABILITIES.email;
    expect(email).toMatchObject({
      mode: "service",
      access: ["write"],
      routes: { send: ["POST"] },
    });
    expect(capabilitySettings(email)).toEqual([
      "EMAIL_FROM",
      "EMAIL_FROM_NAME",
      "EMAIL_REST_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
    ]);
    expect(capabilitySettings(CAPABILITIES.dataforseo)).toEqual([
      "DATAFORSEO_API_KEY",
    ]);
    // The types follow the kinds.
    expectTypeOf<ServiceCapabilityId>().toEqualTypeOf<"email">();
    expectTypeOf<ApiKeyCapabilityId>().toEqualTypeOf<
      "dataforseo" | "context"
    >();
    expectTypeOf<"EMAIL_FROM">().toExtend<CapabilitySecret>();
    expectTypeOf<"CLOUDFLARE_ACCOUNT_ID">().toExtend<CapabilitySecret>();
    expectTypeOf<"DATAFORSEO_API_KEY">().toExtend<CapabilitySecret>();
  });

  it("knows only its own ids", () => {
    expect(isCapabilityId("dataforseo")).toBe(true);
    expect(isCapabilityId("toString")).toBe(false);
    expect(isCapabilityId("openai")).toBe(false);
  });
});
