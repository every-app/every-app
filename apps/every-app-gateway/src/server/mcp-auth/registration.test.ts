import { describe, expect, it } from "vitest";
import { normalizeClientRegistrationRequest } from "./registration";

const REGISTER = "https://gateway.example.com/oauth/register";

function registration(body: unknown, init: RequestInit = {}): Request {
  return new Request(REGISTER, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}

/** The request the library gets, as JSON (or text it can't parse). */
async function forwarded(request: Request): Promise<unknown> {
  const normalized = await normalizeClientRegistrationRequest(request);
  if (!(normalized instanceof Request)) throw new Error("not forwarded");
  const text = await normalized.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** A chunked body (no Content-Length) of `chunks` 64 KiB chunks. */
function chunkedRegistration(chunks: number) {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled === chunks) return controller.close();
      pulled += 1;
      controller.enqueue(new Uint8Array(64 * 1024).fill(32));
    },
  });
  const request = new Request(REGISTER, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    duplex: "half",
  } as RequestInit);
  return { request, pulled: () => pulled };
}

describe("normalizeClientRegistrationRequest", () => {
  it("registers a client that names no method as public", async () => {
    // Codex, Cursor and others omit it and never keep a secret.
    await expect(
      forwarded(
        registration({
          client_name: "Codex",
          redirect_uris: ["http://localhost:1455/auth/callback"],
        }),
      ),
    ).resolves.toEqual({
      client_name: "Codex",
      redirect_uris: ["http://localhost:1455/auth/callback"],
      token_endpoint_auth_method: "none",
    });
  });

  it("keeps a method the client chose", async () => {
    for (const method of [
      "client_secret_post",
      "client_secret_basic",
      "none",
    ]) {
      const metadata = {
        redirect_uris: ["https://example.com/cb"],
        token_endpoint_auth_method: method,
      };
      await expect(forwarded(registration(metadata))).resolves.toEqual(
        metadata,
      );
    }
  });

  it("gives a client known to keep its secret a confidential registration", async () => {
    await expect(
      forwarded(
        registration({
          redirect_uris: ["https://www.perplexity.ai/api/mcp/oauth/callback"],
        }),
      ),
    ).resolves.toMatchObject({
      token_endpoint_auth_method: "client_secret_post",
    });
  });

  it("leaves the choice to a client that lists methods without none", async () => {
    const metadata = {
      redirect_uris: ["https://example.com/cb"],
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
    };
    await expect(forwarded(registration(metadata))).resolves.toEqual(metadata);

    await expect(
      forwarded(
        registration({
          redirect_uris: ["https://example.com/cb"],
          token_endpoint_auth_methods_supported: [
            "client_secret_basic",
            "none",
          ],
        }),
      ),
    ).resolves.toMatchObject({ token_endpoint_auth_method: "none" });
  });

  it("passes through what it can't read, for the library to refuse", async () => {
    await expect(forwarded(registration("not json"))).resolves.toBe("not json");
    await expect(forwarded(registration([]))).resolves.toEqual([]);
    await expect(forwarded(registration(null))).resolves.toBeNull();
    const get = new Request(REGISTER, { method: "GET" });
    expect(await normalizeClientRegistrationRequest(get)).toBe(get);
  });

  it("refuses a body over 16 KiB, without reading the rest of it", async () => {
    const declared = await normalizeClientRegistrationRequest(
      registration(
        { redirect_uris: ["https://example.com/cb"] },
        { headers: { "content-length": String(17 * 1024) } },
      ),
    );
    expect(declared).toBeInstanceOf(Response);
    expect((declared as Response).status).toBe(413);

    // Chunked: no Content-Length to go by.
    const chunked = chunkedRegistration(1_000);
    const refused = await normalizeClientRegistrationRequest(chunked.request);
    expect((refused as Response).status).toBe(413);
    await expect((refused as Response).json()).resolves.toMatchObject({
      error: "invalid_request",
    });
    expect(chunked.pulled()).toBeLessThan(5);

    const fits = await normalizeClientRegistrationRequest(
      registration({
        client_name: "Cursor",
        redirect_uris: ["https://example.com/cb"],
        padding: "x".repeat(15 * 1024),
      }),
    );
    expect(fits).toBeInstanceOf(Request);
  });

  it("keeps only the metadata EveryApp uses", async () => {
    await expect(
      forwarded(
        registration({
          client_name: "Cursor",
          "client_name#ja-Jpan-JP": "カーソル",
          redirect_uris: ["cursor://anysphere.cursor-mcp/oauth/callback"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          contacts: ["x".repeat(5000)],
          logo_uri: "https://example.com/logo.png",
          client_uri: "https://example.com",
          policy_uri: "https://example.com/policy",
          tos_uri: "https://example.com/tos",
          jwks_uri: "https://example.com/jwks.json",
          software_statement: "eyJ...",
          scope: "mcp:read mcp:write",
        }),
      ),
    ).resolves.toEqual({
      client_name: "Cursor",
      redirect_uris: ["cursor://anysphere.cursor-mcp/oauth/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  it("cleans and clips the client's name", async () => {
    const forwardedName = async (name: unknown) =>
      (
        (await forwarded(
          registration({ client_name: name, redirect_uris: ["https://a/cb"] }),
        )) as { client_name?: string }
      ).client_name;
    expect(await forwardedName("  Claude\u202E edoC\u0000  ")).toBe(
      "Claude edoC",
    );
    expect([...((await forwardedName("é".repeat(500))) ?? "")]).toHaveLength(
      200,
    );
    expect(await forwardedName("\u200B\u202E")).toBeUndefined();
    expect(await forwardedName(42)).toBeUndefined();
  });

  it("refuses more than ten redirect URIs, or one over 2 KiB", async () => {
    for (const redirectUris of [
      Array.from({ length: 11 }, (_, index) => `https://example.com/${index}`),
      [`https://example.com/${"x".repeat(2048)}`],
    ]) {
      const refused = await normalizeClientRegistrationRequest(
        registration({ client_name: "x", redirect_uris: redirectUris }),
      );
      expect(refused).toBeInstanceOf(Response);
      expect((refused as Response).status).toBe(400);
      await expect((refused as Response).json()).resolves.toMatchObject({
        error: "invalid_redirect_uri",
      });
    }
    await expect(
      forwarded(
        registration({
          redirect_uris: Array.from(
            { length: 10 },
            (_, index) => `https://example.com/${index}`,
          ),
        }),
      ),
    ).resolves.toMatchObject({ token_endpoint_auth_method: "none" });
  });
});
