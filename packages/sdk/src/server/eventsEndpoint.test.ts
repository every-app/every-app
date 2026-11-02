/**
 * The `app` event sink's app side: `everyApp(handler, { events: { on } })`
 * answers `POST /__everyapp/events` only with the Gateway's `events.deliver`
 * system token for this Worker, minted for this exact body, and for the
 * organization the Worker serves; `on` never runs otherwise.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import {
  APP_EVENTS_PATH,
  EVENT_HEADERS,
  IDENTITY_HEADER,
  SYSTEM_HEADER,
  bodyHash,
  mintIdentityJwt,
  mintSystemJwt,
  type AppEventEnvelope,
} from "../internal";
import { everyApp, type EveryAppOptions } from "./everyApp";
import type { AppEvent } from "./eventsEndpoint";

const ISSUER = "https://home.example.com";
const WORKER = "every-acme-birds";
const ORG = "org_acme";
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const env = {
  EVERYAPP_AUDIENCE: WORKER,
  EVERYAPP_IDENTITY_ISSUER: ISSUER,
  EVERY_APP_ORG_ID: ORG,
};
let privateKeyPem: string;
let publicKeyPem: string;
let otherPrivateKeyPem: string;

beforeAll(async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  privateKeyPem = await exportPKCS8(keys.privateKey);
  publicKeyPem = await exportSPKI(keys.publicKey);
  const other = await generateKeyPair("RS256", { extractable: true });
  otherPrivateKeyPem = await exportPKCS8(other.privateKey);
});

function envelope(overrides: Partial<AppEventEnvelope> = {}): AppEventEnvelope {
  return {
    id: "evt_01",
    type: "member.removed",
    version: 1,
    summary: "Ada removed Cy",
    time: "2026-11-01T10:00:00.000Z",
    gateway: ISSUER,
    organization: { id: ORG, slug: "acme", name: "Acme" },
    actor: { kind: "user", id: "u_ada" },
    data: { user: { id: "u_cy" } },
    ...overrides,
  };
}

async function token(
  body: string,
  overrides: {
    audience?: string;
    purpose?: "tools.list" | "events.deliver";
    key?: string;
    hashOf?: string;
  } = {},
): Promise<string> {
  const purpose = overrides.purpose ?? "events.deliver";
  return mintSystemJwt(overrides.key ?? privateKeyPem, {
    audience: overrides.audience ?? WORKER,
    issuer: ISSUER,
    purpose,
    ...(purpose === "events.deliver"
      ? { bodyHash: await bodyHash(overrides.hashOf ?? body) }
      : {}),
  });
}

function delivery(body: string, headers: Record<string, string>): Request {
  return new Request(`https://birds.acme.example.com${APP_EVENTS_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [EVENT_HEADERS.delivery]: "dlv_1",
      [EVENT_HEADERS.attempt]: "2",
      ...headers,
    },
    body,
  });
}

function appWith(events: EveryAppOptions["events"]) {
  const handler = vi.fn(async () => Response.json({ handler: true }));
  const app = everyApp(handler, {
    publicKeys: [publicKeyPem],
    events,
  });
  return { app, handler };
}

describe("POST /__everyapp/events", () => {
  it("calls on with the envelope, the delivery and the env, once the token checks out", async () => {
    const seen: AppEvent[] = [];
    const { app, handler } = appWith({
      on: { "member.removed": async (event) => void seen.push(event) },
    });
    const body = JSON.stringify(envelope());
    const res = await app.fetch(
      delivery(body, { [SYSTEM_HEADER]: await token(body) }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, handled: true });
    expect(seen).toEqual([
      expect.objectContaining({
        id: "evt_01",
        type: "member.removed",
        organization: expect.objectContaining({ id: ORG }),
        delivery: { id: "dlv_1", attempt: 2 },
      }),
    ]);
    // The app's own handler never sees the reserved path.
    expect(handler).not.toHaveBeenCalled();
  });

  it("acknowledges an event with no handler, and answers 500 when on throws (the Gateway retries)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { app } = appWith({
      on: {
        "group.removed": () => {
          throw new Error("boom");
        },
      },
    });
    const unhandled = JSON.stringify(envelope({ type: "app.updated" }));
    const ok = await app.fetch(
      delivery(unhandled, { [SYSTEM_HEADER]: await token(unhandled) }),
      env,
      ctx,
    );
    expect(await ok.json()).toEqual({ ok: true, handled: false });
    const failing = JSON.stringify(envelope({ type: "group.removed" }));
    const res = await app.fetch(
      delivery(failing, { [SYSTEM_HEADER]: await token(failing) }),
      env,
      ctx,
    );
    expect(res.status).toBe(500);
  });

  it("refuses a delivery without a valid events.deliver token, and never calls on", async () => {
    const on = vi.fn();
    const { app } = appWith({ on });
    const body = JSON.stringify(envelope());
    const identity = await mintIdentityJwt(privateKeyPem, {
      subject: {
        sub: "u_ada",
        email: "a@acme.example",
        orgId: ORG,
        orgRole: "owner",
      },
      audience: WORKER,
      issuer: ISSUER,
    });
    const attempts: Array<[string, Record<string, string>]> = [
      ["no token", {}],
      ["garbage", { [SYSTEM_HEADER]: "not-a-jwt" }],
      [
        "tools.list purpose",
        { [SYSTEM_HEADER]: await token(body, { purpose: "tools.list" }) },
      ],
      [
        "another Worker's",
        {
          [SYSTEM_HEADER]: await token(body, {
            audience: "every-globex-birds",
          }),
        },
      ],
      [
        "signed by another key",
        { [SYSTEM_HEADER]: await token(body, { key: otherPrivateKeyPem }) },
      ],
      [
        "minted for another body",
        { [SYSTEM_HEADER]: await token(body, { hashOf: "{}" }) },
      ],
      ["a user identity", { [IDENTITY_HEADER]: identity }],
      ["a user identity as the system token", { [SYSTEM_HEADER]: identity }],
    ];
    for (const [label, headers] of attempts) {
      const res = await app.fetch(delivery(body, headers), env, ctx);
      expect(res.status, label).toBe(401);
    }
    expect(on).not.toHaveBeenCalled();
  });

  it("refuses an event for another organization than the Worker serves", async () => {
    const on = vi.fn();
    const { app } = appWith({ on });
    const body = JSON.stringify(
      envelope({
        organization: { id: "org_globex", slug: "globex", name: "Globex" },
      }),
    );
    const res = await app.fetch(
      delivery(body, { [SYSTEM_HEADER]: await token(body) }),
      env,
      ctx,
    );
    expect(res.status).toBe(403);
    expect(on).not.toHaveBeenCalled();
  });

  it("answers only POST, and 404 no_handler when the Worker passes no events", async () => {
    const { app } = appWith(undefined);
    const body = JSON.stringify(envelope());
    const get = await app.fetch(
      new Request(`https://birds.acme.example.com${APP_EVENTS_PATH}`),
      env,
      ctx,
    );
    expect(get.status).toBe(405);
    const res = await app.fetch(
      delivery(body, { [SYSTEM_HEADER]: await token(body) }),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "no_handler" });
  });

  it("can't be minted without the body's hash", async () => {
    await expect(
      mintSystemJwt(privateKeyPem, {
        audience: WORKER,
        issuer: ISSUER,
        purpose: "events.deliver",
      }),
    ).rejects.toThrow(/body/);
  });
});
