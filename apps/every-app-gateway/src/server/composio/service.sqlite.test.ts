/**
 * The organization's Composio switch and a person's link against a
 * migrated SQLite database and the fake Composio
 * (docs/design/2026-11-composio.md): who turns it on and off and what
 * turning it off deletes; the sign-in started and finished in each state,
 * the key and the sign-in id sealed and never returned; the status, which
 * stores nothing of what is in a person's Composio; a refused key; the
 * unlink; and a member who leaves or is deactivated. Connections are
 * written straight to the repository here: making one from an app is in
 * connect.sqlite.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  WorkerEntrypoint: class {},
}));

import {
  composioLinkRequests,
  composioLinks,
  providerAppAccess,
  providerConnections,
} from "@/db/schema";
import { ComposioLinkState } from "@/schemas/composio";
import { resetAppSetupCacheForTests } from "@/server/app-setup";
import {
  clearOrgContextCacheForTests,
  type OrgContext,
} from "@/server/organization/orgContext";
import { resetGatewayProvidersForTests } from "@/server/providers";
import { ComposioLinkRepository } from "@/server/repositories/ComposioLinkRepository";
import { OrganizationMembersRepository } from "@/server/repositories/OrganizationMembersRepository";
import { OrgSettingsRepository } from "@/server/repositories/OrgSettingsRepository";
import { ProviderAppAccessRepository } from "@/server/repositories/ProviderAppAccessRepository";
import { ProviderConnectionRepository } from "@/server/repositories/ProviderConnectionRepository";
import { UserRepository } from "@/server/repositories/UserRepository";
import { isSealed } from "@/server/secrets/sealed";
import { fakeComposio, type FakeComposio } from "@/test/fake-composio";
import { deployLiveApp } from "@/test/registry";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";
import {
  composioStatus,
  composioSwitch,
  finishComposioLink,
  setComposio,
  turnComposioOff,
  startComposioLink,
  unlinkComposio,
} from "./service";

const SECRET = "a-secret-long-enough-for-sealing-0123456789";
const OTHER_SECRET = "another-secret-long-enough-0123456789abcdef";

describe("Composio's switch and a person's link (SQLite)", () => {
  let db: TestDb;
  let acme: string;
  let owner: string;
  let admin: string;
  let member: string;
  const rows: Record<string, string> = {};
  let composio: FakeComposio;
  let now: number;
  let logged: string[];

  afterEach(() => {
    vi.useRealTimers();
    fakeEnv.BETTER_AUTH_SECRET = SECRET;
  });

  beforeEach(async () => {
    db = await createTestDb();
    testDb.current = db;
    clearOrgContextCacheForTests();
    resetGatewayProvidersForTests();
    resetAppSetupCacheForTests();
    logged = [];
    for (const level of ["log", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...line: unknown[]) => {
        logged.push(line.map(String).join(" "));
      });
    }
    now = Date.parse("2026-11-10T09:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"], now });
    acme = await seedOrganization(db, "acme");
    owner = await seedMember(db, {
      organizationId: acme,
      role: "owner",
      email: "ben@acme.test",
    });
    admin = await seedMember(db, {
      organizationId: acme,
      role: "admin",
      email: "ada@acme.test",
    });
    member = await seedMember(db, {
      organizationId: acme,
      role: "member",
      email: "pat@acme.test",
    });
    for (const [appSlug, capabilities] of [
      [
        "crm",
        { "github-oauth": { scopes: ["repo"], why: "Lists repositories." } },
      ],
      [
        "mail",
        {
          "google-workspace": {
            scopes: ["gmail.readonly"],
            why: "Reads mail.",
          },
        },
      ],
    ] as const) {
      const plan = await deployLiveApp(db, {
        organizationId: acme,
        appSlug,
        manifest: { id: appSlug, capabilities },
        deployerUserId: owner,
      });
      rows[appSlug] = plan.app.id;
    }
    composio = fakeComposio();
    composio.state.accounts = [
      { slug: "github", wordId: "brave-otter" },
      { slug: "gmail", wordId: "calm-heron", displayName: "alex@gmail.test" },
      { slug: "gmail", wordId: "wise-hen", displayName: "work@gmail.test" },
      {
        slug: "googlecalendar",
        wordId: "quiet-finch",
        displayName: "alex@gmail.test",
      },
      // A service EveryApp maps to no provider: never listed.
      { slug: "salesforce", wordId: "odd-eel", displayName: "crm" },
    ];
    // On, as an owner left it. The tests of the switch turn it themselves.
    await setComposio(org(owner), true);
  });

  const roleOf = (userId: string) =>
    userId === owner ? "owner" : userId === admin ? "admin" : "member";
  const org = (userId: string): OrgContext => ({
    orgId: acme,
    userId,
    role: roleOf(userId),
  });
  const person = (userId: string) => ({ organizationId: acme, userId });

  /** The sign-in id inside the link a start returned. */
  function signInIdOf(url: string): string {
    return new URL(url).searchParams.get("cliKey")!;
  }

  /** Start, approve in Composio, finish: the linked status. */
  async function link(userId: string = owner) {
    const started = await startComposioLink(org(userId), composio.fetch);
    composio.approve(signInIdOf(started.url));
    const finished = await finishComposioLink(org(userId), composio.fetch);
    expect(finished.state).toBe(ComposioLinkState.Linked);
    return { started, finished };
  }

  /** A connection the person made through Composio to GitHub, which crm may use. */
  async function githubThroughComposio(userId: string) {
    await ProviderConnectionRepository.upsertComposio(
      {
        ...person(userId),
        providerId: "github-oauth",
        appRowId: rows["crm"]!,
        accounts: [{ service: "github", id: "ca_0", account: "brave-otter" }],
      },
      fakeEnv,
    );
    await ProviderAppAccessRepository.allow({
      ...person(userId),
      providerId: "github-oauth",
      appRowId: rows["crm"]!,
      scopes: ["repo"],
    });
  }

  /** A connection the person made to Google with the Gateway's own client, which mail may use. */
  async function googleWithAClient(userId: string) {
    await ProviderConnectionRepository.upsert(
      {
        ...person(userId),
        providerId: "google-workspace",
        appRowId: rows["mail"]!,
        label: "ben@acme.test",
        externalId: "g-1",
        scopes: ["gmail.readonly"],
        accessToken: "ya29.token",
        refreshToken: null,
        expiresAt: null,
      },
      fakeEnv,
    );
    await ProviderAppAccessRepository.allow({
      ...person(userId),
      providerId: "google-workspace",
      appRowId: rows["mail"]!,
      scopes: ["gmail.readonly"],
    });
  }

  const names = () => ({ [owner]: "ben", [admin]: "ada", [member]: "pat" });

  /** Every connection, as `person provider via status`, sorted. */
  async function connections(): Promise<string[]> {
    return (await db.select().from(providerConnections))
      .map(
        (row) =>
          `${names()[row.userId]} ${row.providerId} ${row.via} ${row.status}`,
      )
      .sort();
  }

  /** Every access row, as `person provider app`, sorted. */
  async function accessRows(): Promise<string[]> {
    const slugs = Object.fromEntries(
      Object.entries(rows).map(([slug, rowId]) => [rowId, slug]),
    );
    return (await db.select().from(providerAppAccess))
      .map(
        (row) =>
          `${names()[row.userId]} ${row.providerId} ${slugs[row.appRowId]}`,
      )
      .sort();
  }

  async function linkedPeople(): Promise<string[]> {
    return (await db.select().from(composioLinks))
      .map((row) => names()[row.userId]!)
      .sort();
  }

  function requestsTo(path: string): number {
    return composio.state.requests.filter((each) => each.path.startsWith(path))
      .length;
  }

  const NOT_LINKED = {
    composio: "on",
    linked: false,
    account: null,
    providers: null,
  };

  describe("the switch", () => {
    it("is off until an owner or admin turns it on, and a member can neither turn it nor read it", async () => {
      await setComposio(org(owner), false);
      expect(await OrgSettingsRepository.isComposioOn(acme)).toBe(false);
      expect(await composioSwitch(org(owner))).toEqual({
        composio: "off",
        links: 0,
        connections: 0,
      });

      for (const on of [true, false]) {
        await expect(setComposio(org(member), on)).rejects.toMatchObject({
          code: "ADMIN_REQUIRED",
        });
      }
      await expect(composioSwitch(org(member))).rejects.toMatchObject({
        code: "ADMIN_REQUIRED",
      });
      expect(await OrgSettingsRepository.isComposioOn(acme)).toBe(false);

      // An admin turns it on; turning it on again changes nothing.
      expect(await setComposio(org(admin), true)).toEqual({
        composio: "on",
        changed: true,
        removed: { links: 0, connections: 0 },
      });
      expect(await setComposio(org(owner), true)).toEqual({
        composio: "on",
        changed: false,
        removed: { links: 0, connections: 0 },
      });
      expect(await composioSwitch(org(admin))).toMatchObject({
        composio: "on",
      });
      // Every member reads which it is with their own link.
      expect(await composioStatus(org(member))).toMatchObject({
        composio: "on",
      });
    });

    it("counts what turning it off would delete, and off deletes every link, waiting sign-in and connection made through Composio with its access, never one made with a client", async () => {
      await link(owner);
      await link(member);
      await startComposioLink(org(admin), composio.fetch);
      await githubThroughComposio(owner);
      await githubThroughComposio(member);
      await googleWithAClient(owner);
      expect(await composioSwitch(org(admin))).toEqual({
        composio: "on",
        links: 2,
        connections: 2,
      });
      const before = composio.state.requests.length;

      expect(await setComposio(org(admin), false)).toEqual({
        composio: "off",
        changed: true,
        removed: { links: 2, connections: 2 },
      });
      expect(await db.select().from(composioLinks)).toEqual([]);
      expect(await db.select().from(composioLinkRequests)).toEqual([]);
      // The connection made with the Gateway's client stands, with its access.
      expect(await connections()).toEqual([
        "ben google-workspace oauth active",
      ]);
      expect(await accessRows()).toEqual(["ben google-workspace mail"]);
      // Nothing was called at Composio.
      expect(composio.state.requests).toHaveLength(before);
      expect(await composioSwitch(org(owner))).toEqual({
        composio: "off",
        links: 0,
        connections: 0,
      });
      // Off again: nothing to change, nothing to delete.
      expect(await setComposio(org(owner), false)).toEqual({
        composio: "off",
        changed: false,
        removed: { links: 0, connections: 0 },
      });
    });
  });

  describe("turning it off from a page or a tool", () => {
    it("changes nothing unconfirmed while a link or a connection exists, and says what it would delete", async () => {
      // The page last read nothing to delete; a person linked since.
      expect(await composioSwitch(org(admin))).toMatchObject({ links: 0 });
      await link(member);
      await githubThroughComposio(member);

      expect(await turnComposioOff(org(admin), false)).toEqual({
        needsConfirm: { links: 1, connections: 1 },
      });
      expect(await db.select().from(composioLinks)).toHaveLength(1);
      expect(await composioSwitch(org(admin))).toEqual({
        composio: "on",
        links: 1,
        connections: 1,
      });

      expect(await turnComposioOff(org(admin), true)).toEqual({
        composio: "off",
        changed: true,
        removed: { links: 1, connections: 1 },
      });
      expect(await db.select().from(composioLinks)).toEqual([]);
    });

    it("turns off unconfirmed when there is nothing to delete, and stays the owners' and admins'", async () => {
      expect(await turnComposioOff(org(admin), false)).toEqual({
        composio: "off",
        changed: true,
        removed: { links: 0, connections: 0 },
      });
      for (const confirmed of [true, false]) {
        await expect(
          turnComposioOff(org(member), confirmed),
        ).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });
      }
    });
  });

  describe("starting a link", () => {
    it("is refused while Composio is off, without asking Composio", async () => {
      await setComposio(org(owner), false);
      for (const userId of [owner, member]) {
        await expect(
          startComposioLink(org(userId), composio.fetch),
        ).rejects.toMatchObject({ code: "COMPOSIO_OFF" });
      }
      expect(composio.state.requests).toEqual([]);
      expect(await db.select().from(composioLinkRequests)).toEqual([]);
    });

    it("creates a sign-in at Composio and keeps its id sealed, returning only the page to open", async () => {
      const started = await startComposioLink(org(member), composio.fetch);
      const id = signInIdOf(started.url);
      expect(started.url).toBe(`https://dashboard.composio.dev/?cliKey=${id}`);
      expect(started.expiresAt).toBe(now + 10 * 60_000);
      expect(composio.state.requests).toMatchObject([
        {
          method: "POST",
          path: "/cli/create-session",
          body: { scope: "user", source: "EveryApp" },
        },
      ]);
      const stored = await db.select().from(composioLinkRequests);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ organizationId: acme, userId: member });
      expect(isSealed(stored[0]!.signInEnc)).toBe(true);
      expect(JSON.stringify(stored)).not.toContain(id);
      expect(logged.join("\n")).toContain("composio.link_started");
      expect(logged.join("\n")).not.toContain(id);
    });

    it("replaces the sign-in that was waiting", async () => {
      const first = await startComposioLink(org(owner), composio.fetch);
      const second = await startComposioLink(org(owner), composio.fetch);
      expect(signInIdOf(second.url)).not.toBe(signInIdOf(first.url));
      expect(await db.select().from(composioLinkRequests)).toHaveLength(1);
      // Approving the first does nothing: the second is the one checked.
      composio.approve(signInIdOf(first.url));
      expect(await finishComposioLink(org(owner), composio.fetch)).toEqual({
        state: ComposioLinkState.Waiting,
      });
    });

    it("is refused when the person is already linked, and says so when Composio can't be reached", async () => {
      await link();
      const before = composio.state.requests.length;
      await expect(
        startComposioLink(org(owner), composio.fetch),
      ).rejects.toMatchObject({
        code: "COMPOSIO_ALREADY_LINKED",
        message: "Composio is already linked. Unlink it first.",
      });
      expect(composio.state.requests).toHaveLength(before);
      // Another person's link is their own.
      composio.state.intercept = () => new Response("down", { status: 503 });
      await expect(
        startComposioLink(org(member), composio.fetch),
      ).rejects.toMatchObject({
        code: "COMPOSIO_UNAVAILABLE",
        message: "Composio could not be reached. Try again.",
      });
      expect(await db.select().from(composioLinkRequests)).toEqual([]);
    });

    it("says so when this Gateway can't seal", async () => {
      fakeEnv.BETTER_AUTH_SECRET = "";
      await expect(
        startComposioLink(org(owner), composio.fetch),
      ).rejects.toMatchObject({ code: "SEALING_UNAVAILABLE" });
      expect(await db.select().from(composioLinkRequests)).toEqual([]);
    });
  });

  describe("finishing a link", () => {
    it("is expired when nothing was started", async () => {
      expect(await finishComposioLink(org(owner), composio.fetch)).toEqual({
        state: ComposioLinkState.Expired,
      });
      expect(composio.state.requests).toEqual([]);
    });

    it("waits while the person hasn't approved", async () => {
      const started = await startComposioLink(org(owner), composio.fetch);
      expect(await finishComposioLink(org(owner), composio.fetch)).toEqual({
        state: ComposioLinkState.Waiting,
      });
      expect(composio.state.requests.at(-1)).toMatchObject({
        method: "GET",
        path: `/cli/get-session?id=${signInIdOf(started.url)}`,
      });
      expect(await db.select().from(composioLinkRequests)).toHaveLength(1);
      expect(await ComposioLinkRepository.find(person(owner))).toBeNull();
    });

    it("links once approved: the key sealed, the sign-in dropped, what is in their Composio answered, and no connection added", async () => {
      const { started, finished } = await link();
      expect(finished).toEqual({
        state: ComposioLinkState.Linked,
        status: {
          composio: "on",
          linked: true,
          account: "alex@example.com",
          providers: [
            {
              providerId: "github-oauth",
              providerName: "GitHub",
              services: [
                { slug: "github", label: "GitHub", accounts: ["brave-otter"] },
              ],
              connected: false,
            },
            {
              providerId: "google-workspace",
              providerName: "Google",
              services: [
                {
                  slug: "gmail",
                  label: "Gmail",
                  accounts: ["alex@gmail.test", "work@gmail.test"],
                },
                {
                  slug: "googlecalendar",
                  label: "Calendar",
                  accounts: ["alex@gmail.test"],
                },
              ],
              connected: false,
            },
          ],
        },
      });
      // Linking adds no connection, and allows no app.
      expect(await db.select().from(providerConnections)).toEqual([]);
      expect(await db.select().from(providerAppAccess)).toEqual([]);
      expect(await db.select().from(composioLinkRequests)).toEqual([]);
      const [stored] = await db.select().from(composioLinks);
      expect(stored).toMatchObject({
        organizationId: acme,
        userId: owner,
        accountLabel: "alex@example.com",
        composioOrgId: composio.state.orgId,
        composioProjectId: composio.state.projectId,
        composioUserId: composio.state.userId,
        sessionId: null,
        sessionAccounts: null,
      });
      expect(isSealed(stored!.keyEnc)).toBe(true);
      // Neither secret is in a row, an answer or a log line.
      const id = signInIdOf(started.url);
      const everything = [
        JSON.stringify(stored),
        JSON.stringify(finished),
        JSON.stringify(await ComposioLinkRepository.find(person(owner))),
        JSON.stringify(await composioStatus(org(owner), {}, composio.fetch)),
        logged.join("\n"),
      ].join("\n");
      expect(everything).not.toContain(composio.state.key);
      expect(everything).not.toContain("uak_");
      expect(everything).not.toContain(id);
      expect(logged.join("\n")).toContain("composio.linked");
      // The key opens for a call, and only there.
      expect(await ComposioLinkRepository.readKey(person(owner), fakeEnv)).toBe(
        composio.state.key,
      );
      // A check after that is linked, and reads no sign-in.
      const signInReads = requestsTo("/cli/get-session");
      expect((await finishComposioLink(org(owner), composio.fetch)).state).toBe(
        ComposioLinkState.Linked,
      );
      expect(requestsTo("/cli/get-session")).toBe(signInReads);
      // The other member is not linked.
      expect(await composioStatus(org(member), {}, composio.fetch)).toEqual(
        NOT_LINKED,
      );
    });

    it("is expired once the sign-in's time has passed, without asking Composio", async () => {
      const started = await startComposioLink(org(owner), composio.fetch);
      composio.approve(signInIdOf(started.url));
      vi.setSystemTime(started.expiresAt);
      const before = composio.state.requests.length;
      expect(await finishComposioLink(org(owner), composio.fetch)).toEqual({
        state: ComposioLinkState.Expired,
      });
      expect(composio.state.requests).toHaveLength(before);
      expect(await db.select().from(composioLinkRequests)).toEqual([]);
      expect(await ComposioLinkRepository.find(person(owner))).toBeNull();
    });

    it("is expired when Composio no longer knows the sign-in", async () => {
      const started = await startComposioLink(org(owner), composio.fetch);
      composio.expire(signInIdOf(started.url));
      expect(await finishComposioLink(org(owner), composio.fetch)).toEqual({
        state: ComposioLinkState.Expired,
      });
      expect(await db.select().from(composioLinkRequests)).toEqual([]);
    });

    it("is expired when the key was already picked up and no link came of it", async () => {
      const started = await startComposioLink(org(owner), composio.fetch);
      composio.state.signIns.set(signInIdOf(started.url), { status: "used" });
      expect(await finishComposioLink(org(owner), composio.fetch)).toEqual({
        state: ComposioLinkState.Expired,
      });
      expect(await db.select().from(composioLinkRequests)).toEqual([]);
    });

    it("is linked when another check picked the key up and finished meanwhile", async () => {
      const started = await startComposioLink(org(owner), composio.fetch);
      composio.state.signIns.set(signInIdOf(started.url), { status: "used" });
      const finished = await finishComposioLink(org(owner), async (request) => {
        if (request.url.includes("/cli/get-session")) {
          // The other check stores the link while this one is asking.
          await ComposioLinkRepository.store(
            {
              ...person(owner),
              key: composio.state.key,
              accountLabel: "alex@example.com",
              composioOrgId: composio.state.orgId,
              composioProjectId: composio.state.projectId,
              composioUserId: composio.state.userId,
            },
            fakeEnv,
          );
        }
        return composio.fetch(request);
      });
      expect(finished).toMatchObject({
        state: ComposioLinkState.Linked,
        status: { linked: true, account: "alex@example.com" },
      });
      expect(await db.select().from(composioLinkRequests)).toEqual([]);
    });

    it.each([
      ["the organization", "/auth/session/info"],
      ["the consumer project", "/org/consumer/project/resolve"],
    ])(
      "says to start again when %s can't be read after the key was handed out",
      async (_what, path) => {
        const started = await startComposioLink(org(owner), composio.fetch);
        const id = signInIdOf(started.url);
        composio.approve(id);
        composio.state.intercept = (request) =>
          request.path.startsWith(path)
            ? composio.refusal(500, "Internal_Error", 5000)
            : undefined;
        const failure = await finishComposioLink(
          org(owner),
          composio.fetch,
        ).catch((error: unknown) => error);
        expect(failure).toMatchObject({
          code: "COMPOSIO_LINK_FAILED",
          message:
            "Composio approved the sign-in, but the link could not be finished. Start again.",
        });
        expect(String((failure as Error).stack)).not.toContain(
          composio.state.key,
        );
        expect(logged.join("\n")).not.toContain(composio.state.key);
        expect(logged.join("\n")).not.toContain(id);
        expect(await db.select().from(composioLinkRequests)).toEqual([]);
        expect(await db.select().from(composioLinks)).toEqual([]);
        composio.state.intercept = null;
        // The key was handed out once: the next check has nothing to finish.
        expect(await finishComposioLink(org(owner), composio.fetch)).toEqual({
          state: ComposioLinkState.Expired,
        });
      },
    );

    it("links all the same when only the accounts can't be read: what is in their Composio isn't known yet", async () => {
      const started = await startComposioLink(org(owner), composio.fetch);
      composio.approve(signInIdOf(started.url));
      composio.state.intercept = (request) =>
        request.path.startsWith("/connected_accounts")
          ? composio.refusal(500, "Internal_Error", 5000)
          : undefined;
      expect(await finishComposioLink(org(owner), composio.fetch)).toEqual({
        state: ComposioLinkState.Linked,
        status: {
          composio: "on",
          linked: true,
          account: "alex@example.com",
          providers: null,
        },
      });
      expect(await linkedPeople()).toEqual(["ben"]);
    });

    it("keeps the sign-in when Composio can't be reached, so the next check asks again", async () => {
      const started = await startComposioLink(org(owner), composio.fetch);
      composio.approve(signInIdOf(started.url));
      composio.state.intercept = () => new Response("down", { status: 503 });
      await expect(
        finishComposioLink(org(owner), composio.fetch),
      ).rejects.toMatchObject({
        code: "COMPOSIO_UNAVAILABLE",
        message: "Composio could not be reached. Try again.",
      });
      expect(await db.select().from(composioLinkRequests)).toHaveLength(1);
      composio.state.intercept = null;
      expect((await finishComposioLink(org(owner), composio.fetch)).state).toBe(
        ComposioLinkState.Linked,
      );
    });

    it("is expired when the stored sign-in id no longer opens", async () => {
      await startComposioLink(org(owner), composio.fetch);
      fakeEnv.BETTER_AUTH_SECRET = OTHER_SECRET;
      const before = composio.state.requests.length;
      expect(await finishComposioLink(org(owner), composio.fetch)).toEqual({
        state: ComposioLinkState.Expired,
      });
      expect(composio.state.requests).toHaveLength(before);
      expect(await db.select().from(composioLinkRequests)).toEqual([]);
    });
  });

  describe("the status", () => {
    it("reads the link from the Gateway alone, and with `list` what is in the person's Composio from Composio each time, storing none of it", async () => {
      await link();
      const listed = requestsTo("/connected_accounts");
      // Without `list`: the link, and nothing asked of Composio.
      expect(await composioStatus(org(owner), {}, composio.fetch)).toEqual({
        composio: "on",
        linked: true,
        account: "alex@example.com",
        providers: null,
      });
      expect(requestsTo("/connected_accounts")).toBe(listed);

      const providers = async () =>
        (
          await composioStatus(org(owner), { list: true }, composio.fetch)
        ).providers?.map((each) => each.providerId);
      expect(await providers()).toEqual(["github-oauth", "google-workspace"]);
      // Connected in Composio a moment later: the next read has it.
      composio.state.accounts.push({ slug: "slack", wordId: "bold-wren" });
      expect(await providers()).toEqual([
        "github-oauth",
        "slack",
        "google-workspace",
      ]);
      composio.state.accounts = composio.state.accounts.filter(
        (each) => each.slug !== "github",
      );
      expect(await providers()).toEqual(["slack", "google-workspace"]);
      expect(requestsTo("/connected_accounts")).toBe(listed + 3);
      // Only the account list is asked for.
      expect(requestsTo("/auth/session/info")).toBe(1);
      expect(requestsTo("/org/consumer/project/resolve")).toBe(1);
      expect(requestsTo("/tool_router")).toBe(0);
      // Nothing about the accounts is in a row.
      const stored = JSON.stringify([
        await db.select().from(composioLinks),
        await db.select().from(providerConnections),
      ]);
      for (const name of ["bold-wren", "alex@gmail.test", "work@gmail.test"]) {
        expect(stored).not.toContain(name);
      }
    });

    it("says which providers the person's connection to is one made through Composio", async () => {
      await link();
      await githubThroughComposio(owner);
      // Their Google connection was made with the Gateway's client.
      await googleWithAClient(owner);
      const status = await composioStatus(
        org(owner),
        { list: true },
        composio.fetch,
      );
      expect(
        status.providers?.map((each) => [each.providerId, each.connected]),
      ).toEqual([
        ["github-oauth", true],
        ["google-workspace", false],
      ]);
    });

    it("keeps the link and answers no providers when Composio doesn't answer", async () => {
      await link();
      composio.state.intercept = () => new Response("down", { status: 503 });
      expect(
        await composioStatus(org(owner), { list: true }, composio.fetch),
      ).toEqual({
        composio: "on",
        linked: true,
        account: "alex@example.com",
        providers: null,
      });
      expect(logged.join("\n")).toContain("composio.accounts_unavailable");
      expect(await linkedPeople()).toEqual(["ben"]);
    });

    it("removes the link when Composio refuses the key: the person's connections through it turn expired and keep their access rows", async () => {
      await link();
      await link(member);
      await githubThroughComposio(owner);
      await githubThroughComposio(member);
      await googleWithAClient(owner);
      // Ben revoked the key in Composio.
      composio.state.intercept = (request) =>
        request.path.startsWith("/connected_accounts")
          ? composio.refusal(401, "UserApiKey_Unauthorized", 1801)
          : undefined;
      expect(
        await composioStatus(org(owner), { list: true }, composio.fetch),
      ).toEqual(NOT_LINKED);
      expect(await linkedPeople()).toEqual(["pat"]);
      expect(await connections()).toEqual([
        "ben github-oauth composio expired",
        "ben google-workspace oauth active",
        "pat github-oauth composio active",
      ]);
      // The apps stay allowed: linking again and Reconnect brings them back.
      expect(await accessRows()).toEqual([
        "ben github-oauth crm",
        "ben google-workspace mail",
        "pat github-oauth crm",
      ]);
      expect(logged.join("\n")).toContain('"reason":"key_refused"');
      expect(logged.join("\n")).not.toContain("uak_");
    });

    it("does the same when the sealed key no longer opens, without asking Composio", async () => {
      await link();
      await githubThroughComposio(owner);
      fakeEnv.BETTER_AUTH_SECRET = OTHER_SECRET;
      const before = composio.state.requests.length;
      expect(
        await composioStatus(org(owner), { list: true }, composio.fetch),
      ).toEqual(NOT_LINKED);
      expect(composio.state.requests).toHaveLength(before);
      expect(await db.select().from(composioLinks)).toEqual([]);
      expect(await connections()).toEqual([
        "ben github-oauth composio expired",
      ]);
      expect(await accessRows()).toEqual(["ben github-oauth crm"]);
      expect(logged.join("\n")).toContain('"reason":"key_lost"');
    });
  });

  describe("unlinking", () => {
    it("removes the link and the person's connections through it with their access, keeps a connection made with a client, and calls nothing at Composio", async () => {
      await link();
      await link(member);
      await githubThroughComposio(owner);
      await githubThroughComposio(member);
      await googleWithAClient(owner);
      const before = composio.state.requests.length;

      expect(await unlinkComposio(org(owner))).toEqual({ removed: true });
      expect(composio.state.requests).toHaveLength(before);
      expect(await linkedPeople()).toEqual(["pat"]);
      expect(await connections()).toEqual([
        "ben google-workspace oauth active",
        "pat github-oauth composio active",
      ]);
      expect(await accessRows()).toEqual([
        "ben google-workspace mail",
        "pat github-oauth crm",
      ]);
      expect(logged.join("\n")).toContain('"reason":"person"');
      expect(await composioStatus(org(owner), {}, composio.fetch)).toEqual(
        NOT_LINKED,
      );
      expect(await unlinkComposio(org(owner))).toEqual({ removed: false });
      // They can link again.
      await link();
    });

    it("removes the connections a refused key left expired, though the link is already gone", async () => {
      await link();
      await githubThroughComposio(owner);
      composio.state.key = "uak_rotatedAtComposio";
      await composioStatus(org(owner), { list: true }, composio.fetch);
      expect(await linkedPeople()).toEqual([]);
      expect(await connections()).toEqual([
        "ben github-oauth composio expired",
      ]);

      expect(await unlinkComposio(org(owner))).toEqual({ removed: true });
      expect(await connections()).toEqual([]);
      expect(await accessRows()).toEqual([]);
    });

    it("drops a sign-in that was waiting", async () => {
      await startComposioLink(org(owner), composio.fetch);
      expect(await unlinkComposio(org(owner))).toEqual({ removed: false });
      expect(await db.select().from(composioLinkRequests)).toEqual([]);
    });
  });

  describe("a member who leaves", () => {
    async function linkedAndWaiting() {
      await link(member);
      await githubThroughComposio(member);
      // A sign-in waiting beside the link (a request left by a start that
      // lost a race with a finish).
      await ComposioLinkRepository.putRequest(
        {
          ...person(member),
          signInId: "5b2f1c1e-0000-4000-8000-00000000aaaa",
          expiresAt: now + 60_000,
        },
        fakeEnv,
      );
      await link(owner);
      await githubThroughComposio(owner);
      expect(await linkedPeople()).toEqual(["ben", "pat"]);
      expect(await db.select().from(composioLinkRequests)).toHaveLength(1);
    }

    async function onlyTheOwnersIsLeft() {
      expect(await linkedPeople()).toEqual(["ben"]);
      expect(await db.select().from(composioLinkRequests)).toEqual([]);
      expect(await connections()).toEqual(["ben github-oauth composio active"]);
      expect(await accessRows()).toEqual(["ben github-oauth crm"]);
    }

    it("loses their link, any sign-in waiting and their connections when removed from the organization", async () => {
      await linkedAndWaiting();
      expect(
        await OrganizationMembersRepository.removeMember(member, acme),
      ).toBe(true);
      await onlyTheOwnersIsLeft();
    });

    it("loses them when deactivated", async () => {
      await linkedAndWaiting();
      expect(await UserRepository.deactivate(member, "test")).toBe(true);
      await onlyTheOwnersIsLeft();
    });
  });
});
