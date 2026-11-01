import { describe, expect, it } from "vitest";
import {
  handoffReturnPath,
  hashNonce,
  HOST_SESSION_COOKIE,
  hostCookie,
  importHostSessionKey,
  isNonceValue,
  newNonce,
  readCookie,
  signHostToken,
  stripThirdPartyAppHeaders,
  verifyHostToken,
  type HostSessionClaims,
} from "./hostSession";

const SECRET = "test-secret-0123456789abcdefghijklmnopqrstuv";
const NOW = 1_800_000_000_000;

function session(over: Partial<HostSessionClaims> = {}): HostSessionClaims {
  return {
    typ: "session",
    sid: "session-1",
    sub: "user-1",
    app: "row-1",
    host: "todo-acme.everyapp.dev",
    iat: NOW / 1000,
    exp: NOW / 1000 + 60,
    ...over,
  };
}

describe("host tokens", () => {
  it("verifies what the key signed, until it expires", async () => {
    const key = await importHostSessionKey(SECRET);
    const token = await signHostToken(key, session());
    expect(token).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(await verifyHostToken(key, token, "session", NOW)).toEqual(
      session(),
    );
    expect(
      await verifyHostToken(key, token, "session", NOW + 60_000),
    ).toBeNull();
  });

  it("refuses another key's token, a tampered one, the wrong type and junk", async () => {
    const key = await importHostSessionKey(SECRET);
    const otherKey = await importHostSessionKey(`${SECRET}-other`);
    const token = await signHostToken(key, session());
    expect(await verifyHostToken(otherKey, token, "session", NOW)).toBeNull();

    const [version, , mac] = token.split(".");
    const forged = `${version}.${Buffer.from(
      JSON.stringify(session({ sub: "user-2" })),
    ).toString("base64url")}.${mac}`;
    expect(await verifyHostToken(key, forged, "session", NOW)).toBeNull();

    // A session is never a code.
    expect(await verifyHostToken(key, token, "code", NOW)).toBeNull();

    for (const junk of [null, "", "v1", "v2.a.b", "v1.!!.??", `${token}.x`]) {
      expect(await verifyHostToken(key, junk, "session", NOW)).toBeNull();
    }
  });
});

describe("handoff helpers", () => {
  it("makes 32-byte nonces and hashes of the same shape", async () => {
    const nonce = newNonce();
    expect(isNonceValue(nonce)).toBe(true);
    expect(isNonceValue(await hashNonce(nonce))).toBe(true);
    expect(await hashNonce(nonce)).not.toBe(nonce);
    expect(isNonceValue("short")).toBe(false);
    expect(isNonceValue(null)).toBe(false);
  });

  it("reads one cookie by exact name", () => {
    const headers = new Headers({
      cookie: `x${HOST_SESSION_COOKIE}=no; ${HOST_SESSION_COOKIE}=yes; other=1`,
    });
    expect(readCookie(headers, HOST_SESSION_COOKIE)).toBe("yes");
    expect(readCookie(headers, "missing")).toBeNull();
    expect(readCookie(new Headers(), HOST_SESSION_COOKIE)).toBeNull();
  });

  it("writes host-only, secure, HttpOnly, Lax cookies", () => {
    expect(hostCookie(HOST_SESSION_COOKIE, "t", 60)).toBe(
      "__Host-everyapp_s=t; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=60",
    );
  });

  it("returns to the page, never to the exchange path", () => {
    expect(
      handoffReturnPath(new URL("https://a.everyapp.dev/tasks?view=all")),
    ).toBe("/tasks?view=all");
    expect(
      handoffReturnPath(
        new URL("https://a.everyapp.dev/__everyapp/session?code=c"),
      ),
    ).toBe("/");
    // Never somewhere else.
    for (const page of [
      "https://a.everyapp.dev//evil.example/x",
      "https://a.everyapp.dev/\\evil.example/x",
    ]) {
      expect(handoffReturnPath(new URL(page))).toBe("/");
    }
  });
});

describe("stripThirdPartyAppHeaders", () => {
  it("drops credentialed CORS and the perimeter's cookies, whatever their case", () => {
    const headers = new Headers({
      "access-control-allow-origin": "https://other.everyapp.dev",
      "access-control-allow-credentials": "true",
      "content-type": "text/html",
    });
    headers.append("set-cookie", "prefs=dark; Path=/");
    headers.append("set-cookie", "__Host-everyapp_s=planted; Path=/; Secure");
    headers.append("set-cookie", " __HOST-EVERYAPP_N=x; Path=/; Secure");
    headers.append("set-cookie", "__Host-other=kept; Path=/; Secure");
    const stripped = stripThirdPartyAppHeaders(
      new Response("page", { status: 201, headers }),
    );
    expect(stripped.status).toBe(201);
    expect(stripped.headers.get("access-control-allow-credentials")).toBeNull();
    expect(stripped.headers.get("access-control-allow-origin")).toBe(
      "https://other.everyapp.dev",
    );
    expect(stripped.headers.getSetCookie()).toEqual([
      "prefs=dark; Path=/",
      "__Host-other=kept; Path=/; Secure",
    ]);
  });
});
