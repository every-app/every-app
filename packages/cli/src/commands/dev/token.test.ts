import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEV_USER } from "@every-app/perimeter/dev";
import { DEV_ISSUER, DEV_PUBLIC_KEY_PEM } from "@every-app/sdk/dev";
import { IDENTITY_DEV_KEY_ID, IDENTITY_HEADER } from "@every-app/sdk/internal";
import { everyApp, getEveryAppUser } from "@every-app/sdk/server";
import { mintDevToken } from "./token";
import devToken from "./token";
import { DEFAULT_DEV_TOKEN_TTL_SECONDS, parseEmail, parseTtl } from "./tokenFlags";

/** A JWT's header or claims (part 0 or 1), unverified. */
const part = (token: string, index: 0 | 1) =>
  JSON.parse(Buffer.from(token.split(".")[index]!, "base64url").toString()) as { exp: number; iat: number };

/** The env everyAppWorker() gives a dev Worker (sdk/src/cloudflare/worker.ts). */
const devEnv = (appId = "todo") => ({
  EVERYAPP_APP_ID: appId,
  EVERYAPP_DEV: "1",
  EVERYAPP_IDENTITY_PUBLIC_KEYS: JSON.stringify([DEV_PUBLIC_KEY_PEM]),
  EVERYAPP_IDENTITY_ISSUER: DEV_ISSUER,
});

/** An app behind everyApp() that answers with whoever it verified. */
const app = everyApp(async (request, env) =>
  Response.json(await getEveryAppUser(request, env as object)),
);

const call = (token: string, env: Record<string, string>) =>
  app.fetch(
    new Request("http://127.0.0.1:5173/api/me", { headers: { [IDENTITY_HEADER]: token } }),
    env,
    { waitUntil: () => undefined, passThroughOnException: () => undefined } as never,
  );

describe("everyapp dev token", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("mints a token everyApp() accepts in a dev Worker, as the dev user by default", async () => {
    const minted = await mintDevToken({ appId: "todo" });
    expect(minted.header).toBe(IDENTITY_HEADER);
    const response = await call(minted.token, devEnv());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: DEV_USER.sub,
      email: DEV_USER.email,
      orgId: DEV_USER.orgId,
      orgRole: "owner",
      channel: "web",
      scopes: ["*"],
    });
  });

  it("carries the role, user and organization asked for", async () => {
    const member = await mintDevToken({ appId: "todo", role: "member" });
    expect(await (await call(member.token, devEnv())).json()).toMatchObject({
      id: "dev-member",
      email: "member@everyapp.localhost",
      orgRole: "member",
    });
    const ana = await mintDevToken({
      appId: "todo",
      role: "admin",
      email: "ana@example.com",
      orgId: "other-org",
    });
    expect(await (await call(ana.token, devEnv())).json()).toMatchObject({
      id: "dev-ana@example.com",
      email: "ana@example.com",
      orgId: "other-org",
      orgRole: "admin",
    });
  });

  it("signs as the gateway-lite does: dev kid, dev issuer, aud = app id, an hour by default", async () => {
    const now = Date.UTC(2026, 9, 26, 12);
    const minted = await mintDevToken({ appId: "todo", now });
    expect(part(minted.token, 0)).toMatchObject({ alg: "RS256", kid: IDENTITY_DEV_KEY_ID });
    const claims = part(minted.token, 1);
    expect(claims).toMatchObject({ iss: DEV_ISSUER, aud: "todo", typ: "user", chan: "web" });
    expect(claims.exp - claims.iat).toBe(DEFAULT_DEV_TOKEN_TTL_SECONDS);
    expect(minted.expiresAt).toBe(new Date(now + DEFAULT_DEV_TOKEN_TTL_SECONDS * 1000).toISOString());
  });

  it("is refused by another app, after it expires, and by a deployed Worker", async () => {
    const minted = await mintDevToken({ appId: "todo", ttlSeconds: 60, now: Date.now() - 120_000 });
    expect((await call(minted.token, devEnv())).status).toBe(401);

    const fresh = await mintDevToken({ appId: "todo" });
    expect((await call(fresh.token, devEnv("crm"))).status).toBe(401);
    // A deployed Worker: no EVERYAPP_DEV, its Gateway's issuer and audience.
    // Even handed the dev public key, it refuses the dev kid.
    const deployed = {
      EVERYAPP_APP_ID: "todo",
      EVERYAPP_AUDIENCE: "todo",
      EVERYAPP_IDENTITY_PUBLIC_KEYS: JSON.stringify([DEV_PUBLIC_KEY_PEM]),
      EVERYAPP_IDENTITY_ISSUER: "https://apps.example.com",
    };
    expect((await call(fresh.token, deployed)).status).toBe(401);
  });

  it("parses --ttl and --user", () => {
    expect(parseTtl("90")).toBe(90);
    expect(parseTtl("15m")).toBe(900);
    expect(parseTtl("24h")).toBe(86_400);
    expect(() => parseTtl("25h")).toThrow();
    expect(() => parseTtl("0")).toThrow();
    expect(() => parseTtl("1d")).toThrow();
    expect(parseEmail(" Ana@Example.com ")).toBe("ana@example.com");
    expect(() => parseEmail("ana")).toThrow();
  });

  it("reads the app id from everyapp.config.ts and prints the token alone", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "everyapp-dev-token-"));
    await fs.writeFile(
      path.join(dir, "everyapp.config.ts"),
      'export default { id: "notes", name: "Notes" };\n',
    );
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    await devToken({ role: "owner", json: true });
    const done = JSON.parse(written.join("").trim().split("\n").at(-1)!);
    expect(done).toMatchObject({ type: "done", data: { appId: "notes", header: IDENTITY_HEADER } });
    expect((await call(done.data.token, devEnv("notes"))).status).toBe(200);
  });
});
