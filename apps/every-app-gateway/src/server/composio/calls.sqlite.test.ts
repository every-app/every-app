/**
 * An app's call through a connection a person made from their Composio,
 * end to end (docs/design/2026-11-composio.md): the AppGateway
 * entrypoint, the Gateway's own ports over a migrated SQLite database, and
 * the fake Composio. Which service and which account a call is sent with;
 * the session opened for exactly the person's accounts, kept, reused and
 * opened again; an account that is gone from their Composio; a key that
 * is refused or no longer opens; Composio's own failures; each kind of
 * answer; a connection made the other way than the provider is served
 * now; and the status an app reads. The refusals made before Composio is
 * asked are in capabilities/composioCall.test.ts.
 */
import { generateKeyPairSync } from "node:crypto";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const testDb = vi.hoisted(() => ({ current: null as TestDb | null }));
const fakeEnv = vi.hoisted(() => ({
  GATEWAY_URL: "https://home.example.com",
  APP_BASE_DOMAIN: "apps.example.com",
  GATEWAY_DEPLOYMENT_MODE: "self_hosted",
  BETTER_AUTH_SECRET: "a-secret-long-enough-for-sealing-0123456789",
  JWT_PUBLIC_KEY: "",
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

import { mintIdentityJwt } from "@every-app/sdk/internal";
import { eq } from "drizzle-orm";
import {
  composioLinks,
  events,
  providerAppAccess,
  providerConnections,
} from "@/db/schema";
import { DrizzleAppRegistry } from "@/perimeter/drizzleAppRegistry";
import { ComposioLinkState } from "@/schemas/composio";
import {
  clearAppCallerCacheForTests,
  handleAppGatewayRequest,
} from "@/server/app-gateway-entrypoint";
import { resetAppSetupCacheForTests } from "@/server/app-setup";
import { resolveOAuthClient } from "@/server/oauth/client";
import { gatewayHeldTokens } from "@/server/oauth/heldTokens";
import {
  addOAuthProvider,
  removeOAuthClient,
  setOAuthClient,
} from "@/server/oauth/service";
import {
  clearOrgContextCacheForTests,
  type OrgContext,
} from "@/server/organization/orgContext";
import {
  gatewayProviders,
  resetGatewayProvidersForTests,
} from "@/server/providers";
import { ComposioLinkRepository } from "@/server/repositories/ComposioLinkRepository";
import { OrganizationRepository } from "@/server/repositories/OrganizationRepository";
import { ProviderAppAccessRepository } from "@/server/repositories/ProviderAppAccessRepository";
import {
  ProviderConnectionRepository,
  type ComposioAccount,
} from "@/server/repositories/ProviderConnectionRepository";
import { fakeComposio, type FakeComposio } from "@/test/fake-composio";
import { deployLiveApp } from "@/test/registry";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";
import { gatewayComposioCalls } from "./calls";
import { finishComposioLink, setComposio, startComposioLink } from "./service";

const GATEWAY = "https://home.example.com";
const SECRET = "a-secret-long-enough-for-sealing-0123456789";
const MESSAGES =
  "/api/integrations/google-workspace/gmail.googleapis.com/gmail/v1/users/me/messages";
const SITES =
  "/api/integrations/google-workspace/searchconsole.googleapis.com/webmasters/v3/sites";
const REPOS = "/api/integrations/github-oauth/api.github.com/user/repos";

/** The accounts on a person's connections, as the rows name them. */
const WORK: ComposioAccount = {
  service: "gmail",
  id: "ca_work",
  account: "work@gmail.test",
};
const CONSOLE: ComposioAccount = {
  service: "google_search_console",
  id: "ca_sites",
  account: "alex@gmail.test",
};
const OCTO: ComposioAccount = {
  service: "github",
  id: "ca_octo",
  account: "brave-otter",
};

let privateKeyPem: string;

beforeAll(() => {
  const keys = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  privateKeyPem = keys.privateKey;
  fakeEnv.JWT_PUBLIC_KEY = keys.publicKey;
});

describe("an app's call through a connection made from a person's Composio (SQLite)", () => {
  let db: TestDb;
  let acme: string;
  let owner: string;
  let member: string;
  const workers: Record<string, string> = {};
  const rows: Record<string, string> = {};
  let composio: FakeComposio;
  let logged: string[];

  afterEach(() => {
    vi.useRealTimers();
    fakeEnv.BETTER_AUTH_SECRET = SECRET;
  });

  beforeEach(async () => {
    db = await createTestDb();
    testDb.current = db;
    clearAppCallerCacheForTests();
    clearOrgContextCacheForTests();
    resetGatewayProvidersForTests();
    resetAppSetupCacheForTests();
    logged = [];
    for (const level of ["log", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...line: unknown[]) => {
        logged.push(line.map(String).join(" "));
      });
    }
    vi.useFakeTimers({
      toFake: ["Date"],
      now: Date.parse("2026-11-10T09:00:00Z"),
    });
    acme = await seedOrganization(db, "acme");
    owner = await seedMember(db, {
      organizationId: acme,
      role: "owner",
      email: "ben@acme.test",
    });
    member = await seedMember(db, {
      organizationId: acme,
      role: "member",
      email: "pat@acme.test",
    });
    for (const [appSlug, capabilities] of [
      [
        "mail",
        {
          "google-workspace": {
            scopes: ["gmail.readonly"],
            why: "Reads mail.",
          },
        },
      ],
      [
        "seo",
        {
          "google-workspace": {
            scopes: ["webmasters.readonly"],
            why: "Reads Search Console.",
          },
        },
      ],
      // Lists a scope no service of Google's in Composio covers.
      [
        "people",
        {
          "google-workspace": {
            scopes: ["gmail.readonly", "contacts.readonly"],
            why: "Reads contacts.",
          },
        },
      ],
      [
        "crm",
        { "github-oauth": { scopes: ["repo"], why: "Lists repositories." } },
      ],
    ] as const) {
      const plan = await deployLiveApp(db, {
        organizationId: acme,
        appSlug,
        manifest: { id: appSlug, capabilities },
        deployerUserId: owner,
      });
      workers[appSlug] = plan.app.workerName!;
      rows[appSlug] = plan.app.id;
    }
    // Both providers registered, neither with a client, and Composio on.
    for (const preset of ["github-oauth", "google-workspace"]) {
      await addOAuthProvider(org(owner), null, { preset });
    }
    resetGatewayProvidersForTests();
    await setComposio(org(owner), true);
    composio = fakeComposio();
    composio.state.accounts = [
      // Another Gmail account, listed first: never the one a call uses.
      {
        slug: "gmail",
        id: "ca_alex",
        wordId: "calm-heron",
        displayName: "alex@gmail.test",
      },
      {
        slug: "gmail",
        id: "ca_work",
        wordId: "wise-hen",
        displayName: "work@gmail.test",
      },
      {
        slug: "google_search_console",
        id: "ca_sites",
        wordId: "keen-wren",
        displayName: "alex@gmail.test",
      },
      { slug: "github", id: "ca_octo", wordId: "brave-otter" },
    ];
  });

  const org = (userId: string): OrgContext => ({
    orgId: acme,
    userId,
    role: userId === owner ? "owner" : "member",
  });
  const person = (userId: string) => ({ organizationId: acme, userId });

  async function link(userId: string = owner) {
    const started = await startComposioLink(org(userId), composio.fetch);
    composio.approve(new URL(started.url).searchParams.get("cliKey")!);
    const finished = await finishComposioLink(org(userId), composio.fetch);
    expect(finished.state).toBe(ComposioLinkState.Linked);
  }

  /** The person's connection to a provider through Composio, as the Composio page writes it. */
  function connect(
    providerId: string,
    accounts: ComposioAccount[],
    userId: string = owner,
  ) {
    return ProviderConnectionRepository.upsertComposio(
      {
        ...person(userId),
        providerId,
        appRowId: Object.values(rows)[0]!,
        accounts,
      },
      fakeEnv as never,
    );
  }

  /** The person allowed `app` to use their connection, for the scopes it lists. */
  function allow(
    app: string,
    providerId: string,
    scopes: string[],
    userId: string = owner,
  ) {
    return ProviderAppAccessRepository.allow({
      ...person(userId),
      providerId,
      appRowId: rows[app]!,
      scopes,
    });
  }

  /** Ben linked, and uses Gmail, Search Console and GitHub from his Composio in mail, seo and crm. */
  async function benConnected() {
    await link();
    await connect("google-workspace", [WORK, CONSOLE]);
    await allow("mail", "google-workspace", ["gmail.readonly"]);
    await allow("seo", "google-workspace", ["webmasters.readonly"]);
    await connect("github-oauth", [OCTO]);
    await allow("crm", "github-oauth", ["repo"]);
  }

  /**
   * An app's call through the AppGateway entrypoint as a person. Everything
   * that leaves the Gateway goes to the fake Composio, which throws for any
   * other host: no call here reaches a provider's API directly.
   */
  async function appCall(
    appSlug: string,
    path: string,
    options: {
      user?: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    } = {},
  ): Promise<Response> {
    clearAppCallerCacheForTests();
    const userId = options.user ?? owner;
    const headers = new Headers(options.headers);
    headers.set(
      "x-everyapp-identity",
      await mintIdentityJwt(privateKeyPem, {
        subject: {
          sub: userId,
          email: userId === owner ? "ben@acme.test" : "pat@acme.test",
          orgId: acme,
          orgRole: userId === owner ? "owner" : "member",
        },
        audience: workers[appSlug]!,
        issuer: GATEWAY,
        now: Date.now(),
      }),
    );
    const fetchUpstream = composio.fetch;
    return handleAppGatewayRequest({
      request: new Request(`http://every-app-gateway.internal${path}`, {
        method: options.method ?? "GET",
        headers,
        ...(options.body === undefined ? {} : { body: options.body }),
      }),
      props: {
        organizationId: acme,
        appId: appSlug,
        workerName: workers[appSlug],
      },
      env: fakeEnv as never,
      registry: new DrizzleAppRegistry(db as never),
      organizations: OrganizationRepository,
      fetchUpstream,
      providers: gatewayProviders,
      oauth: async () => ({
        resolveClient: resolveOAuthClient,
        connections: gatewayHeldTokens({ fetchUpstream }),
        composio: gatewayComposioCalls({ fetchUpstream }),
      }),
    });
  }

  /** The requests Composio received from `mark` on, as `METHOD path` without the query. */
  function requestsFrom(mark: number): string[] {
    return composio.state.requests
      .slice(mark)
      .map((each) => `${each.method} ${each.path.split("?")[0]}`);
  }

  /** The accounts each session was opened for, in the order they were opened. */
  function sessionsOpened(): unknown[] {
    return composio.state.requests
      .filter((each) => each.path === "/tool_router/session")
      .map(
        (each) =>
          (each.body as { connected_accounts: unknown }).connected_accounts,
      );
  }

  /** Every connection, as `person provider status`, sorted. */
  async function connections(): Promise<string[]> {
    const names: Record<string, string> = { [owner]: "ben", [member]: "pat" };
    return (await db.select().from(providerConnections))
      .map((row) => `${names[row.userId]} ${row.providerId} ${row.status}`)
      .sort();
  }

  async function expiredEvents(): Promise<Record<string, unknown>[]> {
    return (
      await db
        .select({ data: events.data })
        .from(events)
        .where(eq(events.type, "provider.connection_expired"))
    ).map((row) => JSON.parse(row.data) as Record<string, unknown>);
  }

  /** The log lines of one event, parsed. */
  function logs(evt: string): Record<string, unknown>[] {
    return logged.flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        return parsed["evt"] === evt ? [parsed] : [];
      } catch {
        return [];
      }
    });
  }

  async function refusalOf(response: Response) {
    return {
      status: response.status,
      ...((await response.json()) as Record<string, unknown>),
    };
  }

  describe("the service and the account", () => {
    it("are the service that owns the URL and the account the connection names for it, through a session opened for exactly the person's accounts", async () => {
      await benConnected();
      const mark = composio.state.requests.length;

      const mail = await appCall("mail", `${MESSAGES}?q=is%3Aunread`);
      expect(mail.status).toBe(200);
      expect(await mail.json()).toEqual({ ok: true });
      expect(requestsFrom(mark)).toEqual([
        "POST /tool_router/session",
        "POST /tool_router/session/trs_Fake0001/proxy_execute",
      ]);
      // The session names each account on Ben's connections, and no other.
      expect(composio.state.requests[mark]!.body).toEqual({
        user_id: composio.state.userId,
        connected_accounts: {
          gmail: ["ca_work"],
          google_search_console: ["ca_sites"],
          github: ["ca_octo"],
        },
      });
      // Sent with the Gmail account on the row, not the other one in his Composio.
      expect(composio.state.proxyCalls).toMatchObject([
        {
          sessionId: "trs_Fake0001",
          accountId: "ca_work",
          toolkit: "gmail",
          endpoint:
            "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is%3Aunread",
          method: "GET",
        },
      ]);

      // Another service of the same connection, and another provider's.
      expect((await appCall("seo", SITES)).status).toBe(200);
      expect((await appCall("crm", REPOS)).status).toBe(200);
      expect(
        composio.state.proxyCalls.map((call) => [call.toolkit, call.accountId]),
      ).toEqual([
        ["gmail", "ca_work"],
        ["google_search_console", "ca_sites"],
        ["github", "ca_octo"],
      ]);
      expect(sessionsOpened()).toHaveLength(1);
    });

    it("leave a log line with `via` and the service, and mark the connection used", async () => {
      await benConnected();
      const before = await ProviderConnectionRepository.find({
        ...person(owner),
        providerId: "google-workspace",
      });
      expect(before!.lastUsedAt).toBeNull();

      expect((await appCall("mail", MESSAGES)).status).toBe(200);
      expect(logs("integration.proxy.call")).toMatchObject([
        {
          capability: "google-workspace",
          appId: "mail",
          host: "gmail.googleapis.com",
          path: "/gmail/v1/users/me/messages",
          method: "GET",
          userId: owner,
          via: "composio",
          service: "gmail",
          status: 200,
        },
      ]);
      const after = await ProviderConnectionRepository.find({
        ...person(owner),
        providerId: "google-workspace",
      });
      expect(after!.lastUsedAt).toBe(Date.now());
    });

    it("carry the app's request under the person's key, with nothing of the app's own credentials, and the key in no log line", async () => {
      await benConnected();
      const response = await appCall(
        "crm",
        "/api/integrations/github-oauth/api.github.com/repos/acme/site/issues?labels=bug&access_token=mine",
        {
          method: "POST",
          headers: {
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            "content-type": "application/json",
            authorization: "Bearer the-apps-own-token",
            cookie: "session=the-apps-own-cookie",
          },
          body: JSON.stringify({ title: "Broken link", labels: ["bug"] }),
        },
      );
      expect(response.status).toBe(200);
      expect(composio.state.proxyCalls).toEqual([
        {
          sessionId: "trs_Fake0001",
          accountId: "ca_octo",
          toolkit: "github",
          endpoint: "https://api.github.com/repos/acme/site/issues?labels=bug",
          method: "POST",
          parameters: [
            {
              name: "accept",
              value: "application/vnd.github+json",
              type: "header",
            },
            {
              name: "x-github-api-version",
              value: "2022-11-28",
              type: "header",
            },
          ],
          body: { title: "Broken link", labels: ["bug"] },
        },
      ]);
      expect(composio.state.requests.at(-1)!.headers).toMatchObject({
        "x-user-api-key": composio.state.key,
        "x-org-id": composio.state.orgId,
        "x-project-id": composio.state.projectId,
      });
      const everything = JSON.stringify(composio.state.requests);
      expect(everything).not.toContain("the-apps-own-token");
      expect(everything).not.toContain("the-apps-own-cookie");
      expect(everything).not.toContain("x-everyapp-identity");
      expect(logged.join("\n")).not.toContain("uak_");
    });

    it("are each person's own: a member with no connection is sent to connect, whatever a colleague linked", async () => {
      await benConnected();
      await appCall("crm", REPOS);
      const mark = composio.state.requests.length;
      const refused = await appCall("crm", REPOS, { user: member });
      expect(await refusalOf(refused)).toMatchObject({
        status: 409,
        code: "integration_not_connected",
        connectPath: "/connect/github-oauth?app=crm",
        reconnect: false,
      });
      expect(requestsFrom(mark)).toEqual([]);
    });
  });

  describe("the session", () => {
    it("is kept on the person's link and reused, and opened again once Composio says it is gone", async () => {
      await benConnected();
      await appCall("crm", REPOS);
      expect(await ComposioLinkRepository.find(person(owner))).toMatchObject({
        sessionId: "trs_Fake0001",
      });
      let mark = composio.state.requests.length;
      expect((await appCall("crm", REPOS)).status).toBe(200);
      expect(requestsFrom(mark)).toEqual([
        "POST /tool_router/session/trs_Fake0001/proxy_execute",
      ]);

      composio.state.sessions.clear();
      mark = composio.state.requests.length;
      expect((await appCall("crm", REPOS)).status).toBe(200);
      expect(requestsFrom(mark)).toEqual([
        "POST /tool_router/session/trs_Fake0001/proxy_execute",
        "POST /tool_router/session",
        "POST /tool_router/session/trs_Fake0002/proxy_execute",
      ]);
      expect(await ComposioLinkRepository.find(person(owner))).toMatchObject({
        sessionId: "trs_Fake0002",
      });
      // The provider saw each call once.
      expect(composio.state.proxyCalls).toHaveLength(3);

      // Gone again straight after it was opened: no third try.
      composio.state.intercept = (request) =>
        request.path.endsWith("/proxy_execute")
          ? composio.refusal(404, "ToolRouterV2_SessionNotFound", 4301)
          : undefined;
      mark = composio.state.requests.length;
      const failed = await appCall("crm", REPOS);
      expect(await refusalOf(failed)).toMatchObject({
        status: 502,
        code: "integration_upstream_failed",
      });
      expect(requestsFrom(mark)).toHaveLength(3);
    });

    it("is opened again when the person's connections name other accounts by now", async () => {
      await benConnected();
      await appCall("mail", MESSAGES);
      // Ben chose his other Gmail account for the connection, and
      // disconnected GitHub.
      await connect("google-workspace", [
        { service: "gmail", id: "ca_alex", account: "alex@gmail.test" },
        CONSOLE,
      ]);
      await ProviderConnectionRepository.remove(
        (await ProviderConnectionRepository.find({
          ...person(owner),
          providerId: "github-oauth",
        }))!,
      );

      const mark = composio.state.requests.length;
      expect((await appCall("mail", MESSAGES)).status).toBe(200);
      expect(requestsFrom(mark)).toEqual([
        "POST /tool_router/session",
        "POST /tool_router/session/trs_Fake0002/proxy_execute",
      ]);
      expect(sessionsOpened().at(-1)).toEqual({
        gmail: ["ca_alex"],
        google_search_console: ["ca_sites"],
      });
      expect(composio.state.proxyCalls.at(-1)).toMatchObject({
        sessionId: "trs_Fake0002",
        accountId: "ca_alex",
      });
    });
  });

  describe("an account that is gone from the person's Composio", () => {
    const withoutWork = () => {
      composio.state.accounts = composio.state.accounts.filter(
        (each) => each.id !== "ca_work",
      );
    };
    const gone = {
      status: 409,
      error: "Conflict",
      code: "integration_not_connected",
      message:
        "The account this Google connection uses is gone from this person's Composio; connect it again at /connect/google-workspace?app=mail.",
      connectPath: "/connect/google-workspace?app=mail",
      reconnect: true,
    };

    it("removed after the session was opened: the call answers 409 to reconnect, the connection turns expired once, and nothing is sent with another account", async () => {
      await benConnected();
      expect((await appCall("mail", MESSAGES)).status).toBe(200);
      // Ben removed that Gmail account in Composio; his other one is still there.
      withoutWork();

      const refused = await appCall("mail", MESSAGES);
      expect(refused.headers.get("x-everyapp-error")).toBe(
        "integration_not_connected",
      );
      expect(await refusalOf(refused)).toEqual(gone);
      expect(await connections()).toEqual([
        "ben github-oauth active",
        "ben google-workspace expired",
      ]);
      expect(await expiredEvents()).toMatchObject([
        {
          provider: { id: "google-workspace", name: "Google" },
          // The connection's name: its two accounts.
          account: {
            user: { id: owner },
            label: "work@gmail.test, alex@gmail.test",
          },
          app: { id: "mail" },
        },
      ]);
      // Only the first call reached Gmail: none went out with `ca_alex`.
      expect(composio.state.proxyCalls).toHaveLength(1);

      // The next call asks Composio nothing, and says it no second time.
      const mark = composio.state.requests.length;
      expect(await refusalOf(await appCall("mail", MESSAGES))).toMatchObject({
        status: 409,
        code: "integration_not_connected",
        reconnect: true,
      });
      expect(requestsFrom(mark)).toEqual([]);
      expect(await expiredEvents()).toHaveLength(1);
      // seo uses the same connection: it reads Needs reconnect for it too.
      expect((await appCall("seo", SITES)).status).toBe(409);
    });

    it("removed before a session was opened: the same, and the person's other connections through Composio keep working", async () => {
      await benConnected();
      withoutWork();
      const mark = composio.state.requests.length;

      expect(await refusalOf(await appCall("mail", MESSAGES))).toEqual(gone);
      // Composio opened no session for an account that is gone; the
      // person's accounts were read once to see which.
      expect(requestsFrom(mark)).toEqual([
        "POST /tool_router/session",
        "GET /connected_accounts",
      ]);
      expect(await connections()).toEqual([
        "ben github-oauth active",
        "ben google-workspace expired",
      ]);
      expect(await expiredEvents()).toHaveLength(1);
      expect(composio.state.proxyCalls).toEqual([]);

      // GitHub still works, through a session for what is left.
      expect((await appCall("crm", REPOS)).status).toBe(200);
      expect(sessionsOpened().at(-1)).toEqual({ github: ["ca_octo"] });
      expect(composio.state.proxyCalls).toMatchObject([
        { toolkit: "github", accountId: "ca_octo" },
      ]);
    });

    it("on another connection doesn't stop this one's call", async () => {
      await benConnected();
      withoutWork();
      // The session can't be opened for Gmail's account; it is opened for the rest.
      expect((await appCall("crm", REPOS)).status).toBe(200);
      expect(sessionsOpened()).toEqual([
        {
          gmail: ["ca_work"],
          google_search_console: ["ca_sites"],
          github: ["ca_octo"],
        },
        { github: ["ca_octo"] },
      ]);
      expect(await connections()).toEqual([
        "ben github-oauth active",
        "ben google-workspace expired",
      ]);
    });
  });

  describe("a key Composio refuses", () => {
    const refused = {
      status: 409,
      error: "Conflict",
      code: "integration_not_connected",
      message:
        "Composio refused this person's key, so their GitHub connection can't be used; they link Composio again at /connect/github-oauth?app=crm.",
      connectPath: "/connect/github-oauth?app=crm",
      reconnect: true,
    };

    it.each([
      ["on a call", "/proxy_execute", true],
      ["when a session is opened", "/tool_router/session", false],
    ])(
      "%s: the link is deleted, every connection of theirs through Composio turns expired, their access rows stay, and the app is told to reconnect",
      async (_when, path, sessionFirst) => {
        await benConnected();
        await link(member);
        await connect("github-oauth", [OCTO], member);
        await allow("crm", "github-oauth", ["repo"], member);
        if (sessionFirst) await appCall("crm", REPOS);
        // Ben revoked his key in Composio.
        composio.state.intercept = (request) =>
          request.path.endsWith(path)
            ? composio.refusal(401, "UserApiKey_Unauthorized", 1801)
            : undefined;

        const answer = await appCall("crm", REPOS);
        const body = await answer.text();
        expect({ status: answer.status, ...JSON.parse(body) }).toEqual(refused);
        expect(
          (await db.select().from(composioLinks)).map((row) => row.userId),
        ).toEqual([member]);
        expect(await connections()).toEqual([
          "ben github-oauth expired",
          "ben google-workspace expired",
          "pat github-oauth active",
        ]);
        // The apps stay allowed: linking again and Reconnect brings them back.
        expect(await db.select().from(providerAppAccess)).toHaveLength(4);
        expect(await expiredEvents()).toMatchObject([
          { provider: { id: "github-oauth" }, app: { id: "crm" } },
        ]);
        const lines = logged.join("\n");
        expect(lines).toContain('"reason":"key_refused"');
        expect(lines).not.toContain("uak_");
        expect(body).not.toContain("uak_");

        // The next call asks Composio nothing.
        composio.state.intercept = null;
        const mark = composio.state.requests.length;
        expect((await appCall("crm", REPOS)).status).toBe(409);
        expect(requestsFrom(mark)).toEqual([]);
        // Pat's own link and connection still work.
        expect((await appCall("crm", REPOS, { user: member })).status).toBe(
          200,
        );
      },
    );

    it("or a sealed key that no longer opens: the same, and Composio isn't asked", async () => {
      await benConnected();
      fakeEnv.BETTER_AUTH_SECRET =
        "another-secret-long-enough-0123456789abcdef";
      const mark = composio.state.requests.length;
      expect(await refusalOf(await appCall("crm", REPOS))).toEqual(refused);
      expect(requestsFrom(mark)).toEqual([]);
      expect(await db.select().from(composioLinks)).toEqual([]);
      expect(await connections()).toEqual([
        "ben github-oauth expired",
        "ben google-workspace expired",
      ]);
      expect(logged.join("\n")).toContain('"reason":"key_lost"');
    });
  });

  describe("Composio's own failures", () => {
    it("an error of its own, an answer in another shape, or no answer: 502, with none of its text and nothing of the key, and nothing changes", async () => {
      await benConnected();
      const answers: (() => Response)[] = [
        () => composio.refusal(500, "Internal_ServerError", 9000),
        () => composio.refusal(429, "RateLimit_Exceeded", 9001),
        () => Response.json({ result_type: "completed", status: "200" }),
        () => new Response("<html>bad gateway</html>", { status: 502 }),
        () => {
          throw new Error(`connect failed for ${composio.state.key}`);
        },
      ];
      for (const answer of answers) {
        composio.state.intercept = (request) =>
          request.path.endsWith("/proxy_execute") ? answer() : undefined;
        const failed = await appCall("crm", REPOS);
        expect(failed.headers.get("x-everyapp-error")).toBe(
          "integration_upstream_failed",
        );
        expect(await refusalOf(failed)).toEqual({
          status: 502,
          error: "Bad Gateway",
          code: "integration_upstream_failed",
          message: "GitHub could not be reached through Composio.",
        });
      }
      expect(logs("integration.proxy.upstream_failed")).toHaveLength(5);
      expect(logs("integration.proxy.upstream_failed")[0]).toMatchObject({
        via: "composio",
        service: "github",
      });
      const lines = logged.join("\n");
      expect(lines).not.toContain("A message nothing may rely on");
      expect(lines).not.toContain("uak_");
      // The link and the connections stand after a failure that isn't the key's.
      expect(await db.select().from(composioLinks)).toHaveLength(1);
      expect(await connections()).toEqual([
        "ben github-oauth active",
        "ben google-workspace active",
      ]);
      expect(await expiredEvents()).toEqual([]);
    });

    it("a host Composio doesn't send the service's calls to: 400", async () => {
      await benConnected();
      composio.state.domains["github"] = ["uploads.github.com"];
      expect(await refusalOf(await appCall("crm", REPOS))).toMatchObject({
        status: 400,
        code: "invalid_integration_route",
      });
    });
  });

  describe("the provider's answer", () => {
    beforeEach(async () => {
      await benConnected();
    });

    it("comes back as JSON or as text, with the provider's status and without its cookies", async () => {
      composio.state.provider = () => ({
        status: 422,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-ratelimit-remaining": "58",
          "set-cookie": "octo=1",
          "x-served-by": ["a", "b"],
        },
        data: { message: "Validation Failed" },
      });
      const json = await appCall("crm", REPOS);
      expect(json.status).toBe(422);
      expect(Object.fromEntries(json.headers)).toEqual({
        "content-type": "application/json; charset=utf-8",
        "x-ratelimit-remaining": "58",
      });
      expect(await json.json()).toEqual({ message: "Validation Failed" });

      composio.state.provider = () => ({
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "set-cookie": "octo=2",
        },
        data: "# site\n",
      });
      const text = await appCall("crm", REPOS);
      expect(Object.fromEntries(text.headers)).toEqual({
        "content-type": "text/plain; charset=utf-8",
      });
      expect(await text.text()).toBe("# site\n");
    });

    it("comes back as bytes fetched from Composio's storage, without the key and without following a redirect", async () => {
      const bytes = new Uint8Array([0x1f, 0x8b, 8, 0, 255, 0, 7]);
      const file = composio.store("site.tar.gz", bytes, "application/gzip");
      composio.state.provider = () => ({
        status: 200,
        headers: {
          "content-type": "application/x-gzip",
          "set-cookie": "octo=3",
        },
        binary: file,
      });
      const response = await appCall("crm", REPOS);
      expect(response.status).toBe(200);
      expect(Object.fromEntries(response.headers)).toEqual({
        "content-type": "application/gzip",
      });
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
      const download = composio.state.requests.at(-1)!;
      expect(download).toMatchObject({
        method: "GET",
        url: file.url,
        redirect: "error",
      });
      expect(download.headers["x-user-api-key"]).toBeUndefined();
      expect(download.headers["x-org-id"]).toBeUndefined();
    });

    it("is refused when its bytes are on another host than Composio's storage", async () => {
      composio.state.provider = () => ({
        status: 200,
        binary: {
          url: "https://files.example.com/site.tar.gz",
          contentType: "application/gzip",
          size: 7,
        },
      });
      const mark = composio.state.requests.length;
      expect(await refusalOf(await appCall("crm", REPOS))).toMatchObject({
        status: 502,
        code: "integration_upstream_failed",
      });
      // Nothing was fetched from it.
      expect(requestsFrom(mark)).toEqual([
        "POST /tool_router/session",
        "POST /tool_router/session/trs_Fake0001/proxy_execute",
      ]);
    });
  });

  describe("a connection made the other way than the provider is served now", () => {
    it("through Composio, once the provider has a client: refused to reconnect, and Composio isn't asked", async () => {
      await benConnected();
      await setOAuthClient(org(owner), null, "github-oauth", {
        clientId: "gh-client-id",
        clientSecret: "gh-client-secret",
      });
      const mark = composio.state.requests.length;
      expect(await refusalOf(await appCall("crm", REPOS))).toEqual({
        status: 409,
        error: "Conflict",
        code: "integration_not_connected",
        message:
          "This GitHub connection was made through Composio, and this Gateway has its own OAuth app for the provider now; connect it again at /connect/github-oauth?app=crm.",
        connectPath: "/connect/github-oauth?app=crm",
        reconnect: true,
      });
      expect(requestsFrom(mark)).toEqual([]);
      // Nothing is deleted or expired: the row reads Needs reconnect.
      expect(await connections()).toContain("ben github-oauth active");

      expect(
        await (await appCall("crm", "/api/integrations/github-oauth")).json(),
      ).toMatchObject({
        configured: true,
        ready: false,
        connection: { label: "brave-otter", ready: false, reconnect: true },
      });
      // The client removed again: served through Composio, as it was made.
      await removeOAuthClient(org(owner), null, "github-oauth");
      expect((await appCall("crm", REPOS)).status).toBe(200);
    });

    it("with a client that is gone, while the provider is served through Composio: refused to reconnect, and nothing is sent", async () => {
      await link();
      await ProviderConnectionRepository.upsert(
        {
          ...person(owner),
          providerId: "github-oauth",
          appRowId: rows["crm"]!,
          label: "ben",
          externalId: "4242",
          scopes: ["repo"],
          accessToken: "bens-token",
          refreshToken: null,
          expiresAt: null,
        },
        fakeEnv as never,
      );
      await allow("crm", "github-oauth", ["repo"]);
      const mark = composio.state.requests.length;
      expect(await refusalOf(await appCall("crm", REPOS))).toEqual({
        status: 409,
        error: "Conflict",
        code: "integration_not_connected",
        message:
          "This GitHub connection was made with an OAuth app this Gateway no longer has; connect it again at /connect/github-oauth?app=crm.",
        connectPath: "/connect/github-oauth?app=crm",
        reconnect: true,
      });
      // Neither to Composio nor, with the token, to GitHub (the fake
      // throws for any other host).
      expect(requestsFrom(mark)).toEqual([]);
      expect(
        await (await appCall("crm", "/api/integrations/github-oauth")).json(),
      ).toMatchObject({
        configured: true,
        ready: false,
        connection: { label: "ben", ready: false, reconnect: true },
      });
    });
  });

  describe("the status an app reads", () => {
    const status = async (app: string, provider: string, user = owner) =>
      (await (
        await appCall(app, `/api/integrations/${provider}`, { user })
      ).json()) as Record<string, unknown>;

    it("says the provider is set up when Composio serves what the app lists, with the person's connection once they allowed the app, and asks Composio nothing", async () => {
      await benConnected();
      const mark = composio.state.requests.length;
      expect(await status("mail", "google-workspace")).toEqual({
        capability: "google-workspace",
        requested: true,
        configured: true,
        ready: true,
        scopes: ["gmail.readonly"],
        connectPath: "/connect/google-workspace?app=mail",
        connection: {
          label: "work@gmail.test, alex@gmail.test",
          scopes: [],
          ready: true,
        },
        settings: [],
        setup: null,
        command: null,
      });
      // A member who hasn't connected: set up, and no connection.
      expect(await status("mail", "google-workspace", member)).toMatchObject({
        configured: true,
        ready: false,
        connection: null,
      });
      expect(requestsFrom(mark)).toEqual([]);
    });

    it("says it isn't set up for an app that lists a scope no service covers, or while Composio is off", async () => {
      await benConnected();
      expect(await status("people", "google-workspace")).toMatchObject({
        requested: true,
        configured: false,
        ready: false,
        setup: expect.stringContaining("Google"),
      });
      const call = await appCall(
        "people",
        "/api/integrations/google-workspace/gmail.googleapis.com/gmail/v1/users/me/profile",
      );
      expect(await refusalOf(call)).toMatchObject({
        status: 503,
        code: "integration_not_configured",
      });

      await setComposio(org(owner), false);
      expect(await status("mail", "google-workspace")).toMatchObject({
        configured: false,
        ready: false,
        connection: null,
      });
      expect(await refusalOf(await appCall("mail", MESSAGES))).toMatchObject({
        status: 503,
        code: "integration_not_configured",
      });
    });
  });
});
