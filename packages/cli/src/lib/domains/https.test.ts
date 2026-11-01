import { describe, expect, it } from "vitest";
import { probeHttps } from "./https";

/** A fetch that fails the way undici's does: TypeError, the cause inside. */
function failing(cause: Error | string): typeof fetch {
  return (async () => {
    throw new TypeError("fetch failed", {
      cause: typeof cause === "string" ? new Error(cause) : cause,
    });
  }) as typeof fetch;
}

const coded = (code: string, message = code) => Object.assign(new Error(message), { code });

describe("probeHttps", () => {
  it("answers with the status, and Cloudflare Access's login for what it is", async () => {
    await expect(
      probeHttps("https://todo.apps.example.com/", (async () => new Response("ok")) as typeof fetch),
    ).resolves.toEqual({ answered: true, status: 200, access: false });
    await expect(
      probeHttps(
        "https://todo.apps.example.com/",
        (async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://acme.cloudflareaccess.com/cdn-cgi/access/login/x" },
          })) as typeof fetch,
      ),
    ).resolves.toEqual({ answered: true, status: 302, access: true });
  });

  it.each([
    ["ENOTFOUND", coded("ENOTFOUND", "todo.apps.example.com has no address at its zone's nameservers yet")],
    ["EAI_AGAIN", coded("EAI_AGAIN", "getaddrinfo EAI_AGAIN todo.apps.example.com")],
    ["ENODATA", coded("ENODATA")],
    ["a getaddrinfo message without a code", "getaddrinfo ENOTFOUND todo.apps.example.com"],
  ])("calls a name that doesn't resolve dns: %s", async (_case, cause) => {
    await expect(probeHttps("https://todo.apps.example.com/", failing(cause))).resolves.toMatchObject({
      answered: false,
      kind: "dns",
    });
  });

  it.each([
    ["ERR_SSL_*", coded("ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE", "sslv3 alert handshake failure")],
    ["ERR_TLS_*", coded("ERR_TLS_CERT_ALTNAME_INVALID", "Hostname/IP does not match")],
    ["EPROTO", coded("EPROTO", "write EPROTO")],
    ["ECONNRESET", coded("ECONNRESET", "socket hang up")],
    ["a handshake message", "SSL alert number 40: handshake failure"],
    ["a certificate message", "unable to verify the first certificate"],
  ])("calls a failing TLS handshake tls: %s", async (_case, cause) => {
    await expect(probeHttps("https://todo.apps.example.com/", failing(cause))).resolves.toMatchObject({
      answered: false,
      kind: "tls",
    });
  });

  it.each([
    ["ECONNREFUSED", coded("ECONNREFUSED", "connect ECONNREFUSED 104.21.21.211:443")],
    ["a connect timeout", coded("UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error")],
  ])("calls anything else other: %s", async (_case, cause) => {
    await expect(probeHttps("https://todo.apps.example.com/", failing(cause))).resolves.toMatchObject({
      answered: false,
      kind: "other",
    });
  });

  it("says why, from the error's cause", async () => {
    await expect(
      probeHttps("https://todo.apps.example.com/", failing("SSL alert number 40: handshake failure")),
    ).resolves.toEqual({
      answered: false,
      reason: "SSL alert number 40: handshake failure",
      kind: "tls",
    });
  });

  it("calls a timeout other", async () => {
    const hangs = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as typeof fetch;

    await expect(probeHttps("https://todo.apps.example.com/", hangs, 1)).resolves.toMatchObject({
      answered: false,
      kind: "other",
    });
  });

  it("reaches no network in tests without a fetch of its own", async () => {
    await expect(probeHttps("https://todo.apps.example.com/")).resolves.toMatchObject({
      answered: false,
      reason: expect.stringContaining("tests don't reach the network"),
    });
  });
});
