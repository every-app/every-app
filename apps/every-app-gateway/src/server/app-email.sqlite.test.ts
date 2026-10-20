/**
 * An installation's email configuration against a migrated SQLite
 * database: the senders `everyapp email set --sender` stores on the app's
 * registry row (`apps.email_senders`), read back through the registry the
 * Worker uses and applied to the `email` capability's sender rule through
 * the AppGateway entrypoint. The manifest declares that the app sends; the
 * row says as whom.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const testDb = vi.hoisted(() => ({ current: null as TestDb | null }));

vi.mock("cloudflare:workers", () => ({
  env: {
    GATEWAY_DEPLOYMENT_MODE: "self_hosted",
    BETTER_AUTH_SECRET: "test-secret-0123456789abcdefghijklmnopqrstuv",
  },
}));
vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  return { db: testDbProxy(testDb) };
});

import { eq } from "drizzle-orm";
import { apps } from "@/db/schema";
import { DrizzleAppRegistry } from "@/perimeter/drizzleAppRegistry";
import {
  clearAppCallerCacheForTests,
  handleAppGatewayRequest,
} from "@/server/app-gateway-entrypoint";
import { OrganizationRepository } from "@/server/repositories/OrganizationRepository";
import { AppService } from "@/server/services/AppService";
import { deployLiveApp, markAppDeployed, registerApp } from "@/test/registry";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";

const SEND = "http://every-app-gateway.internal/api/integrations/email/send";
const STATUS = "http://every-app-gateway.internal/api/integrations/email";
const INBOX = {
  id: "inbox",
  capabilities: {
    email: { access: "write", why: "Sends from the mailboxes." },
  },
};

describe("app email configuration (SQLite)", () => {
  let db: TestDb;
  let acme: string;
  let owner: string;
  let appRowId: string;
  let workerName: string;
  let registry: DrizzleAppRegistry;
  const send = vi.fn();

  beforeEach(async () => {
    db = await createTestDb();
    testDb.current = db;
    clearAppCallerCacheForTests();
    send.mockReset().mockResolvedValue({
      messageId: "<m1@example.com>",
      status: "delivered",
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    acme = await seedOrganization(db, "acme");
    owner = await seedMember(db, { organizationId: acme, role: "owner" });
    const plan = await deployLiveApp(db, {
      organizationId: acme,
      appSlug: "inbox",
      manifest: INBOX,
      deployerUserId: owner,
    });
    appRowId = plan.app.id;
    workerName = plan.app.workerName!;
    registry = new DrizzleAppRegistry(db as never);
  });

  /** The gateway's mail as the capability sees it; nothing is sent for real. */
  const mail = async () => ({
    isConfigured: () => true,
    sender: () => ({
      address: "noreply@gateway.example.com",
      name: "Every App",
    }),
    provider: () => "cloudflare" as const,
    send,
    recipientHash: async () => "0".repeat(32),
  });

  function call(url: string, body?: unknown) {
    return handleAppGatewayRequest({
      request: new Request(url, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      props: { organizationId: acme, appId: "inbox", workerName },
      env: { GATEWAY_DEPLOYMENT_MODE: "self_hosted" },
      registry,
      organizations: OrganizationRepository,
      mail,
    });
  }

  const sendAs = (from: string) =>
    call(SEND, {
      to: "customer@example.net",
      subject: "Re: order",
      text: "Hi",
      from,
    });

  async function setRow(
    values: Partial<{ emailSenders: string | null; manifest: string }>,
  ) {
    await db.update(apps).set(values).where(eq(apps.id, appRowId));
  }

  async function columns() {
    const [row] = await db
      .select({
        emailSenders: apps.emailSenders,
        emailInbound: apps.emailInbound,
      })
      .from(apps)
      .where(eq(apps.id, appRowId));
    return row;
  }

  it("sends as a sender the app's row allows, and refuses one it doesn't, naming the command", async () => {
    await setRow({ emailSenders: '["*@mail.example.com"]' });
    clearAppCallerCacheForTests();

    expect((await sendAs("support@mail.example.com")).status).toBe(200);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: { address: "support@mail.example.com" },
      }),
    );

    const refused = await sendAs("x@other.example");
    expect(refused.status).toBe(403);
    expect(refused.headers.get("x-everyapp-error")).toBe(
      "email_sender_not_allowed",
    );
    const body = (await refused.json()) as { message: string };
    expect(body.message).toContain("everyapp email set --sender");
    expect(body.message).not.toContain("everyapp.config.ts");
    expect(send).toHaveBeenCalledOnce();
  });

  it("echoes the row's senders in the status", async () => {
    await setRow({ emailSenders: '["*@mail.example.com", "ceo@example.com"]' });
    clearAppCallerCacheForTests();
    await expect((await call(STATUS)).json()).resolves.toMatchObject({
      requested: true,
      ready: true,
      senders: ["*@mail.example.com", "ceo@example.com"],
    });
  });

  it("ignores senders left in a stored manifest snapshot", async () => {
    // A row deployed before the lists moved: the gateway reads the column,
    // which is null, never the manifest's `senders`.
    await setRow({
      manifest: JSON.stringify({
        id: "inbox",
        capabilities: {
          email: { access: "write", senders: ["*@mail.example.com"] },
        },
      }),
      emailSenders: null,
    });
    clearAppCallerCacheForTests();
    const refused = await sendAs("support@mail.example.com");
    expect(refused.status).toBe(403);
    expect(refused.headers.get("x-everyapp-error")).toBe(
      "email_sender_not_allowed",
    );
    await expect((await call(STATUS)).json()).resolves.toMatchObject({
      senders: [],
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps the configuration across a redeploy", async () => {
    await setRow({ emailSenders: '["*@mail.example.com"]' });
    await markAppDeployed(db, appRowId, {
      versionId: "inbox-version-2",
      manifest: { ...INBOX, name: "Inbox" },
    });
    clearAppCallerCacheForTests();
    expect((await sendAs("support@mail.example.com")).status).toBe(200);
    await expect(columns()).resolves.toEqual({
      emailSenders: '["*@mail.example.com"]',
      emailInbound: null,
    });
  });

  it("applies a changed row once the caller cache expires", async () => {
    await setRow({ emailSenders: '["*@mail.example.com"]' });
    clearAppCallerCacheForTests();
    expect((await sendAs("support@mail.example.com")).status).toBe(200);

    // The row changes under a cached caller: the old rule holds until the
    // cache expires (30 s), then the new one applies.
    await setRow({ emailSenders: null });
    expect((await sendAs("support@mail.example.com")).status).toBe(200);
    clearAppCallerCacheForTests();
    expect((await sendAs("support@mail.example.com")).status).toBe(403);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("forgets both lists when the app is deleted, and a revived app starts with none", async () => {
    await db
      .update(apps)
      .set({
        emailSenders: '["*@mail.example.com"]',
        emailInbound: '["*@example.com"]',
      })
      .where(eq(apps.id, appRowId));

    await AppService.delete(
      { orgId: acme, userId: owner, role: "owner" },
      appRowId,
    );
    await expect(columns()).resolves.toEqual({
      emailSenders: null,
      emailInbound: null,
    });

    const revived = await registerApp(db, {
      organizationId: acme,
      appSlug: "inbox",
      manifest: INBOX,
      deployerUserId: owner,
    });
    expect(revived).toMatchObject({ kind: "revived", app: { id: appRowId } });
    await expect(columns()).resolves.toEqual({
      emailSenders: null,
      emailInbound: null,
    });
  });

  it("reads a row whose list isn't JSON as the words in it, which match no address", async () => {
    // A hand-written column is read as a comma or whitespace list (the one
    // parser for the row and .dev.vars): "nope" is one entry no address
    // matches, so a `from` on any domain is refused.
    await setRow({ emailSenders: "nope" });
    clearAppCallerCacheForTests();
    for (const from of ["support@mail.example.com", "x@nope.example"]) {
      const refused = await sendAs(from);
      expect(refused.status, from).toBe(403);
      expect(refused.headers.get("x-everyapp-error"), from).toBe(
        "email_sender_not_allowed",
      );
    }
    await expect((await call(STATUS)).json()).resolves.toMatchObject({
      senders: ["nope"],
    });
    expect(send).not.toHaveBeenCalled();
  });
});
