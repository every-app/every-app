/**
 * Which GATEWAY_URLs can be an OAuth issuer, and the local-testing knob for
 * short access tokens, against the real library.
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  env: {},
  waitUntil: () => undefined,
  WorkerEntrypoint: class {},
}));
vi.mock("./validate", () => ({
  mcpBearerValidator: () => async () => null,
  // Every connection stands, so a code exchange goes through.
  grantStands: async () => true,
}));
const resources = vi.hoisted(() => ({ origins: [] as string[] }));
vi.mock("./resources", () => ({
  currentAppResources: async () => resources.origins,
}));

import { createKvFake } from "@/test/kv-fake";
import { getMcpAuth, refreshMcpAuth, resetMcpAuthForTests } from "./config";

function envFor(gatewayUrl: string, extra: Record<string, unknown> = {}) {
  return {
    GATEWAY_URL: gatewayUrl,
    OAUTH_KV: createKvFake().kv,
    ...extra,
  } as unknown as Cloudflare.Env;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getMcpAuth", () => {
  it("issues from GATEWAY_URL's origin, canonicalized", async () => {
    const auth = getMcpAuth(envFor("https://Apps.Example.com:443/admin/"));
    expect(auth).toMatchObject({
      issuer: "https://apps.example.com",
      resource: "https://apps.example.com/mcp",
    });
  });

  it("accepts http only on exactly localhost or 127.0.0.1", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(getMcpAuth(envFor("http://localhost:19123"))?.issuer).toBe(
      "http://localhost:19123",
    );
    expect(getMcpAuth(envFor("http://127.0.0.1:19123"))?.issuer).toBe(
      "http://127.0.0.1:19123",
    );
    for (const url of [
      "http://every-app-gateway.localhost:3000",
      "http://gateway.example.com",
      "not a url",
      "",
    ]) {
      expect(getMcpAuth(envFor(url)), url).toBeNull();
    }
  });

  it("shortens access tokens for local testing only", async () => {
    const issueToken = async (gatewayUrl: string) => {
      const env = envFor(gatewayUrl, { MCP_ACCESS_TOKEN_TTL: "120" });
      const auth = getMcpAuth(env)!;
      const oauth = auth.authorizationServer.getOAuthApi(env);
      const client = await oauth.createClient({
        redirectUris: ["http://localhost:4000/cb"],
        tokenEndpointAuthMethod: "none",
      });
      const verifier = "v".repeat(43);
      const request = await oauth.parseAuthRequest(
        new Request(
          `${auth.issuer}/oauth/authorize?${new URLSearchParams({
            response_type: "code",
            client_id: client.clientId,
            redirect_uri: "http://localhost:4000/cb",
            code_challenge: createHash("sha256")
              .update(verifier)
              .digest("base64url"),
            code_challenge_method: "S256",
          })}`,
        ),
      );
      const { redirectTo } = await oauth.completeAuthorization({
        request,
        userId: "user-1",
        scope: ["mcp:read"],
        props: {},
        metadata: {},
      });
      const response = await auth.authorizationServer.fetch(
        new Request(`${auth.issuer}/oauth/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: new URL(redirectTo).searchParams.get("code")!,
            redirect_uri: "http://localhost:4000/cb",
            client_id: client.clientId,
            code_verifier: verifier,
          }),
        }),
        env,
        { waitUntil: () => undefined, passThroughOnException() {} } as never,
      );
      return ((await response.json()) as { expires_in: number }).expires_in;
    };

    expect(await issueToken("http://localhost:19124")).toBe(120);
    expect(await issueToken("https://apps.example.com")).toBe(3600);
  });

  it("keeps /mcp up when an app resource is one the library refuses (a dev gateway's seeded hosts)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    resetMcpAuthForTests();
    resources.origins = ["http://openseo.apps.example.com"];
    const env = envFor("http://localhost:19343");
    const auth = await refreshMcpAuth(env, null);
    expect(auth?.issuer).toBe("http://localhost:19343");
    expect(auth?.appResources).toEqual([]);
    expect(auth?.resource).toBe("http://localhost:19343/mcp");

    resources.origins = ["http://127.0.0.1"];
    const next = await refreshMcpAuth(env, null);
    expect(next?.appResources).toEqual(["http://127.0.0.1"]);
    resources.origins = [];
    resetMcpAuthForTests();
  });
});
