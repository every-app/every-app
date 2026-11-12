/**
 * What the Gateway's Allow page shows
 * (docs/design/2026-11-oauth-one-connection.md), against a migrated SQLite
 * database: the app asking to use the signed-in person's connection, the
 * account the connection is to, what the app says it does with it and the
 * scopes it lists; and nothing for a state that isn't this person's
 * `allow` state, or once what the page would show is no longer true.
 * Reading it spends nothing: the page's form posts the state
 * (spec-flow.sqlite.test.ts drives that form).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const testDb = vi.hoisted(() => ({ current: null as TestDb | null }));
const fakeEnv = vi.hoisted(() => ({
  GATEWAY_URL: "https://home.example.com",
  APP_BASE_DOMAIN: "apps.example.com",
  GATEWAY_DEPLOYMENT_MODE: "self_hosted",
  BETTER_AUTH_SECRET: "a-secret-long-enough-for-sealing-0123456789",
}));

vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  return { db: testDbProxy(testDb) };
});
vi.mock("cloudflare:workers", () => ({
  env: fakeEnv,
  waitUntil: () => undefined,
}));

import { eq } from "drizzle-orm";
import { oauthStates, providerConnections, userAppAccess } from "@/db/schema";
import type { OrgContext } from "@/server/organization/orgContext";
import { resetGatewayProvidersForTests } from "@/server/providers";
import {
  OAuthStatePurpose,
  OAuthStateRepository,
} from "@/server/repositories/OAuthStateRepository";
import { ProviderConnectionRepository } from "@/server/repositories/ProviderConnectionRepository";
import { ProviderRepository } from "@/server/repositories/ProviderRepository";
import { deployLiveApp } from "@/test/registry";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";
import { buildAppAccessContext } from "./appAccessConsent";

/** A provider no code knows: everything about it is this spec. */
const SPEC = {
  id: "acme-mail",
  name: "Acme Mail",
  description: "Mail at Acme, as the person who connects.",
  docs: "https://console.acme-mail.example/apps",
  hosts: ["api.acme-mail.example"],
  auth: {
    kind: "oauth2-user",
    authorizeUrl: "https://auth.acme-mail.example/authorize",
    tokenUrl: "https://auth.acme-mail.example/token",
    clientId: "ACME_MAIL_CLIENT_ID",
    clientSecret: "ACME_MAIL_CLIENT_SECRET",
    inject: "basic",
    pkce: true,
    scopeSeparator: "space",
    scopePrefix: "https://acme-mail.example/scopes/",
    identity: {
      url: "https://api.acme-mail.example/me",
      label: "email",
      id: "id",
      scopes: ["profile"],
    },
  },
} as const;
const NOW = Date.parse("2026-11-10T09:00:00Z");
const GONE = {
  ok: false,
  message: "This page was used already or expired. Open the app again.",
};

describe("the Allow page's context (SQLite)", () => {
  let db: TestDb;
  let acme: string;
  let notes: string;
  let ben: { id: string; email: string; org: OrgContext };
  let pat: { id: string; email: string; org: OrgContext };

  /** Deploy notes, listing the provider for `scopes` (or not at all). */
  async function deployNotes(scopes: string[] | null): Promise<string> {
    const plan = await deployLiveApp(db, {
      organizationId: acme,
      appSlug: "notes",
      name: "Notes",
      manifest: {
        id: "notes",
        icon: "/everyapp-icon.svg",
        capabilities: scopes
          ? { "acme-mail": { scopes, why: "Files mail into notes." } }
          : {},
      },
    });
    return plan.app.id;
  }

  /** The state a connect from inside notes left for the Allow page. */
  function allowState(
    state: string,
    overrides: Partial<Parameters<typeof OAuthStateRepository.put>[0]> = {},
  ) {
    return OAuthStateRepository.put({
      state,
      providerId: "acme-mail",
      organizationId: acme,
      userId: ben.id,
      appRowId: notes,
      purpose: OAuthStatePurpose.Allow,
      codeVerifier: "",
      scopes: ["mail.read", "contacts.read"],
      returnTo: "https://notes.apps.example.com/",
      now: new Date(NOW),
      ...overrides,
    });
  }

  function connectionOf(userId: string) {
    return ProviderConnectionRepository.find({
      organizationId: acme,
      providerId: "acme-mail",
      userId,
    });
  }

  beforeEach(async () => {
    db = await createTestDb();
    testDb.current = db;
    resetGatewayProvidersForTests();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    acme = await seedOrganization(db, "acme");
    const person = async (role: "owner" | "member", email: string) => {
      const id = await seedMember(db, { organizationId: acme, role, email });
      return {
        id,
        email,
        org: { orgId: acme, userId: id, role } as OrgContext,
      };
    };
    ben = await person("owner", "ben@acme.test");
    pat = await person("member", "pat@acme.test");
    notes = await deployNotes(["mail.read", "contacts.read"]);
    // Pat opens notes by a person's grant.
    await db.insert(userAppAccess).values({
      id: "grant-pat-notes",
      organizationId: acme,
      userId: pat.id,
      appRowId: notes,
    });
    await ProviderRepository.insert({
      id: "acme-mail",
      spec: JSON.stringify(SPEC),
      addedBy: "ben@acme.test",
    });
    resetGatewayProvidersForTests();
    // Ben's one connection: what every app listed at the connect, and the
    // spec's identity scope.
    await ProviderConnectionRepository.upsert(
      {
        organizationId: acme,
        providerId: "acme-mail",
        userId: ben.id,
        appRowId: notes,
        label: "inbox@acme.test",
        externalId: "7",
        scopes: ["mail.read", "mail.send", "contacts.read", "profile"],
        accessToken: "access-token-nobody-sees",
        refreshToken: "refresh-token-nobody-sees",
        expiresAt: NOW + 3_600_000,
      },
      fakeEnv,
    );
  });

  it("shows the app, the account, what the app does with it and the scopes the app lists, never the others the connection holds", async () => {
    await allowState("state-1");
    const context = await buildAppAccessContext(ben, "state-1", NOW);
    expect(context).toEqual({
      ok: true,
      state: "state-1",
      action: "/connect/acme-mail/allow",
      email: "ben@acme.test",
      provider: { id: "acme-mail", name: "Acme Mail" },
      app: {
        id: "notes",
        name: "Notes",
        hostname: "notes.apps.example.com",
        status: "active",
        icon: "/everyapp-icon.svg",
      },
      account: "inbox@acme.test",
      why: "Files mail into notes.",
      // Not `mail.send`, which the connection holds for another app, nor
      // `profile`, the Gateway's own ask.
      scopes: ["mail.read", "contacts.read"],
    });
    // Never a token.
    expect(JSON.stringify(context)).not.toContain("nobody-sees");
    // Reading spends nothing: the page's form still has its state to post.
    expect(await buildAppAccessContext(ben, "state-1", NOW)).toEqual(context);
    expect(await db.select().from(oauthStates)).toHaveLength(1);
  });

  it("shows the app's scopes as it wrote them", async () => {
    // notes spells one scope in full.
    await deployNotes([
      "mail.read",
      "https://acme-mail.example/scopes/contacts.read",
    ]);
    await allowState("state-1");
    expect(await buildAppAccessContext(ben, "state-1", NOW)).toMatchObject({
      ok: true,
      scopes: ["mail.read", "https://acme-mail.example/scopes/contacts.read"],
    });
  });

  it("answers ok: false once the app lists more than it did when the connect started, though the connection holds it", async () => {
    // The state holds what notes listed then: mail.read and contacts.read.
    await allowState("state-1");
    expect(await buildAppAccessContext(ben, "state-1", NOW)).toMatchObject({
      ok: true,
      scopes: ["mail.read", "contacts.read"],
    });
    // Redeployed listing `mail.send` too, which Ben's connection holds.
    await deployNotes(["mail.read", "contacts.read", "mail.send"]);
    expect((await connectionOf(ben.id))!.scopes).toContain("mail.send");
    // The form would allow no more than the state's scopes, so the page
    // shows nothing: the app starts again.
    expect(await buildAppAccessContext(ben, "state-1", NOW)).toEqual(GONE);
    // Nothing was spent by looking.
    expect(await db.select().from(oauthStates)).toHaveLength(1);

    // A state started after the redeploy shows all three.
    await allowState("state-2", {
      scopes: ["mail.read", "contacts.read", "mail.send"],
    });
    expect(await buildAppAccessContext(ben, "state-2", NOW)).toMatchObject({
      ok: true,
      scopes: ["mail.read", "contacts.read", "mail.send"],
    });
    // An app that lists less by now is shown for what it lists now.
    await deployNotes(["mail.read"]);
    expect(await buildAppAccessContext(ben, "state-1", NOW)).toMatchObject({
      ok: true,
      scopes: ["mail.read"],
    });
  });

  it("answers ok: false for someone else's state, a spent or expired one, one that never was, and one the provider's callback spends", async () => {
    await allowState("state-1");
    // Pat opens notes too, and has a connection of their own: the state is Ben's.
    await ProviderConnectionRepository.upsert(
      {
        organizationId: acme,
        providerId: "acme-mail",
        userId: pat.id,
        appRowId: notes,
        label: "pat@acme.test",
        externalId: "8",
        scopes: ["mail.read", "mail.send", "contacts.read", "profile"],
        accessToken: "pats-token",
        refreshToken: null,
        expiresAt: null,
      },
      fakeEnv,
    );
    expect(await buildAppAccessContext(pat, "state-1", NOW)).toEqual(GONE);
    // Ben, acting in another organization.
    expect(
      await buildAppAccessContext(
        { ...ben, org: { ...ben.org, orgId: "org-elsewhere" } },
        "state-1",
        NOW,
      ),
    ).toEqual(GONE);
    expect(await buildAppAccessContext(ben, "state-missing", NOW)).toEqual(
      GONE,
    );
    // Past its ten minutes.
    expect(
      await buildAppAccessContext(ben, "state-1", NOW + 11 * 60_000),
    ).toEqual(GONE);
    // None of those spent it: it is still Ben's to use.
    expect(await buildAppAccessContext(ben, "state-1", NOW)).toMatchObject({
      ok: true,
    });

    // An `authorize` state is the provider's callback's, never this page's.
    await allowState("state-authorize", {
      purpose: OAuthStatePurpose.Authorize,
      codeVerifier: "verifier",
    });
    expect(await buildAppAccessContext(ben, "state-authorize", NOW)).toEqual(
      GONE,
    );

    // Spent by the form.
    await OAuthStateRepository.take("state-1", new Date(NOW));
    expect(await buildAppAccessContext(ben, "state-1", NOW)).toEqual(GONE);
  });

  it("answers ok: false once the connection no longer holds what the app lists, expired or is gone", async () => {
    await allowState("state-1");
    const changed = {
      ok: false,
      message:
        "Your Acme Mail connection changed since this page opened. Open Notes and connect again.",
    };
    const connection = (await connectionOf(ben.id))!;
    await db
      .update(providerConnections)
      .set({ scopes: JSON.stringify(["mail.read", "mail.send", "profile"]) })
      .where(eq(providerConnections.id, connection.id));
    expect(await buildAppAccessContext(ben, "state-1", NOW)).toEqual(changed);

    await db
      .update(providerConnections)
      .set({
        scopes: JSON.stringify(["mail.read", "contacts.read", "profile"]),
      })
      .where(eq(providerConnections.id, connection.id));
    expect(await buildAppAccessContext(ben, "state-1", NOW)).toMatchObject({
      ok: true,
    });
    await ProviderConnectionRepository.markExpired(connection.id);
    expect(await buildAppAccessContext(ben, "state-1", NOW)).toEqual(changed);

    await ProviderConnectionRepository.remove(connection);
    expect(await buildAppAccessContext(ben, "state-1", NOW)).toEqual(changed);
  });

  it("answers ok: false once the person no longer opens the app, or the app no longer lists the provider", async () => {
    // Pat's own connection and state.
    await ProviderConnectionRepository.upsert(
      {
        organizationId: acme,
        providerId: "acme-mail",
        userId: pat.id,
        appRowId: notes,
        label: "pat@acme.test",
        externalId: "8",
        scopes: ["mail.read", "contacts.read", "profile"],
        accessToken: "pats-token",
        refreshToken: null,
        expiresAt: null,
      },
      fakeEnv,
    );
    await allowState("state-pat", { userId: pat.id });
    expect(await buildAppAccessContext(pat, "state-pat", NOW)).toMatchObject({
      ok: true,
      email: "pat@acme.test",
      account: "pat@acme.test",
    });
    await db
      .delete(userAppAccess)
      .where(eq(userAppAccess.id, "grant-pat-notes"));
    expect(await buildAppAccessContext(pat, "state-pat", NOW)).toEqual(GONE);

    // notes is redeployed without the provider.
    await allowState("state-1");
    await deployNotes(null);
    expect(await buildAppAccessContext(ben, "state-1", NOW)).toEqual(GONE);
  });
});
