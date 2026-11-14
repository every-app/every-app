/**
 * Using an account from a person's Composio in an app
 * (docs/design/2026-11-composio.md), against a migrated SQLite database,
 * the fake Composio and a fake GitHub: where `GET /connect/<id>?app=<app>`
 * leads for a provider with no client; what the Gateway's Composio page
 * shows in each step; what its form (`POST /connect/<id>/composio`)
 * writes and what it refuses; a second app, on the Composio page or the
 * Allow page; Reconnect on Accounts; a client added or removed later;
 * what an app needs of a person; the setup gate; the lists; and a
 * disconnect. An app's call through the connection is in
 * calls.sqlite.test.ts.
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
const session = vi.hoisted(() => ({
  current: null as {
    user: { id: string; email: string };
    session: { activeOrganizationId: string | null };
  } | null,
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
vi.mock("@/auth", () => ({
  auth: { api: { getSession: async () => session.current } },
}));

import { OAUTH_PRESETS } from "@every-app/sdk/internal";
import { eq } from "drizzle-orm";
import {
  composioLinks,
  events,
  oauthStates,
  providerAppAccess,
  providerConnections,
} from "@/db/schema";
import { ReconnectOutcome } from "@/schemas/app-access";
import { ComposioLinkState } from "@/schemas/composio";
import {
  appSettingsReport,
  resetAppSetupCacheForTests,
} from "@/server/app-setup";
import { buildAppAccessContext } from "@/server/oauth/appAccessConsent";
import { connectionNeeds } from "@/server/oauth/connection-needs";
import { serveConnectRoute, startReconnect } from "@/server/oauth/flow";
import {
  addOAuthProvider,
  disconnect,
  listConnections,
  listProviders,
  removeOAuthClient,
  setOAuthClient,
} from "@/server/oauth/service";
import {
  clearOrgContextCacheForTests,
  type OrgContext,
} from "@/server/organization/orgContext";
import { resetGatewayProvidersForTests } from "@/server/providers";
import {
  OAuthStatePurpose,
  OAuthStateRepository,
} from "@/server/repositories/OAuthStateRepository";
import { ProviderConnectionRepository } from "@/server/repositories/ProviderConnectionRepository";
import { isSealed } from "@/server/secrets/sealed";
import { fakeComposio, type FakeComposio } from "@/test/fake-composio";
import { fakeOAuthProvider } from "@/test/fake-oauth-provider";
import { deployLiveApp } from "@/test/registry";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";
import { buildComposioContext } from "./connect";
import {
  composioStatus,
  finishComposioLink,
  setComposio,
  startComposioLink,
} from "./service";

const GATEWAY = "https://home.example.com";
const MAIL = "https://mail.apps.example.com/settings";
const INBOX = "https://inbox.apps.example.com/";
const GITHUB = OAUTH_PRESETS["github-oauth"]! as {
  auth: { authorizeUrl: string; tokenUrl: string };
};
const NO_CLIENT =
  "has no client on this Gateway yet. An owner or admin adds one under Manage workspace → Providers.";
const USED = "This page was used already or expired. Open the app again.";

type Manifest = { id: string; capabilities: Record<string, unknown> };

/** The apps of the organization: what each lists, and why. */
const APPS: Record<string, { name: string; manifest: Manifest }> = {
  mail: {
    name: "OpenMail",
    manifest: {
      id: "mail",
      capabilities: {
        "google-workspace": {
          scopes: ["gmail.modify"],
          why: "Reads and sends mail.",
        },
      },
    },
  },
  // Needs a service of Google's that mail's connection also holds.
  inbox: {
    name: "Inbox",
    manifest: {
      id: "inbox",
      capabilities: {
        "google-workspace": {
          scopes: ["openid", "gmail.readonly"],
          why: "Shows unread mail.",
        },
      },
    },
  },
  // Needs another service of Google's.
  seo: {
    name: "OpenSEO",
    manifest: {
      id: "seo",
      capabilities: {
        "google-workspace": {
          scopes: ["webmasters.readonly"],
          why: "Reads Search Console.",
        },
      },
    },
  },
  // Lists a scope no service of Google's in Composio covers.
  people: {
    name: "People",
    manifest: {
      id: "people",
      capabilities: {
        "google-workspace": {
          scopes: ["gmail.readonly", "contacts.readonly"],
          why: "Reads contacts.",
        },
      },
    },
  },
  crm: {
    name: "CRM",
    manifest: {
      id: "crm",
      capabilities: {
        "github-oauth": { scopes: ["repo"], why: "Lists repositories." },
      },
    },
  },
  ci: {
    name: "CI",
    manifest: {
      id: "ci",
      capabilities: {
        "github-oauth": {
          scopes: ["repo", "workflow"],
          why: "Opens issues for failed builds.",
        },
      },
    },
  },
};

/** The accounts in the person's Composio. */
const ALEX = {
  slug: "gmail",
  id: "ca_alex",
  wordId: "calm-heron",
  displayName: "alex@gmail.test",
};
const WORK = {
  slug: "gmail",
  id: "ca_work",
  wordId: "wise-hen",
  displayName: "work@gmail.test",
};
const OCTO = { slug: "github", id: "ca_octo", wordId: "brave-otter" };
const SITES = {
  slug: "google_search_console",
  id: "ca_sites",
  wordId: "keen-wren",
  displayName: "alex@gmail.test",
};

describe("using an account from a person's Composio in an app (SQLite)", () => {
  let db: TestDb;
  let acme: string;
  let owner: string;
  let member: string;
  const rows: Record<string, string> = {};
  let composio: FakeComposio;
  let github: ReturnType<typeof fakeOAuthProvider>;
  /** Every request that left for a host that isn't Composio's. */
  let providerRequests: string[];
  let now: number;

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Deploy an app of {@link APPS}, as it is listed there or with other capabilities. */
  async function deploy(
    appSlug: string,
    capabilities: Record<string, unknown> = APPS[appSlug]!.manifest
      .capabilities,
  ) {
    const plan = await deployLiveApp(db, {
      organizationId: acme,
      appSlug,
      name: APPS[appSlug]!.name,
      manifest: { id: appSlug, capabilities },
      deployerUserId: owner,
    });
    rows[appSlug] = plan.app.id;
  }

  beforeEach(async () => {
    db = await createTestDb();
    testDb.current = db;
    clearOrgContextCacheForTests();
    resetGatewayProvidersForTests();
    resetAppSetupCacheForTests();
    for (const level of ["log", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation(() => undefined);
    }
    now = Date.parse("2026-11-10T09:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"], now });
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
    for (const appSlug of Object.keys(APPS)) await deploy(appSlug);
    // Both providers registered, neither with a client.
    for (const preset of ["github-oauth", "google-workspace"]) {
      await addOAuthProvider(org(owner), null, { preset });
    }
    resetGatewayProvidersForTests();
    composio = fakeComposio();
    composio.state.accounts = [ALEX, WORK, OCTO];
    github = fakeOAuthProvider({
      authorizeUrl: GITHUB.auth.authorizeUrl,
      tokenUrl: GITHUB.auth.tokenUrl,
      apiHost: "api.github.com",
      clientId: "gh-client-id",
      clientSecret: "gh-client-secret",
      scopeDialect: "comma",
      identity: { path: "/user", body: { login: "ben", id: 4242 } },
    });
    providerRequests = [];
    signIn(owner);
    // An owner turned Composio on.
    await setComposio(org(owner), true);
  });

  const emailOf = (userId: string) =>
    userId === owner ? "ben@acme.test" : "pat@acme.test";
  const org = (userId: string): OrgContext => ({
    orgId: acme,
    userId,
    role: userId === owner ? "owner" : "member",
  });
  const personOf = (userId: string) => ({
    id: userId,
    email: emailOf(userId),
    org: org(userId),
  });
  /** What names the owner's one connection to a provider. */
  const keyOf = (providerId: string, userId: string = owner) => ({
    organizationId: acme,
    providerId,
    userId,
  });
  const googleKey = () => keyOf("google-workspace");

  function signIn(userId: string) {
    session.current = {
      user: { id: userId, email: emailOf(userId) },
      session: { activeOrganizationId: acme },
    };
  }

  /** Composio's requests go to the fake Composio, a provider's to the fake GitHub. */
  const upstream = (request: Request) => {
    if (new URL(request.url).hostname.endsWith(".composio.dev")) {
      return composio.fetch(request);
    }
    providerRequests.push(`${request.method} ${request.url}`);
    return github.fetch(request);
  };
  const deps = () => ({ fetchUpstream: upstream, now: () => now });

  /** A browser's GET on the gateway host, as the signed-in person. */
  async function browse(path: string): Promise<Response> {
    return (await serveConnectRoute(new Request(`${GATEWAY}${path}`), deps()))!;
  }

  /** A page's form, posted by the signed-in person. */
  async function post(
    path: string,
    fields: Record<string, string>,
  ): Promise<Response> {
    const answered = await serveConnectRoute(
      new Request(`${GATEWAY}${path}`, {
        method: "POST",
        body: new URLSearchParams(fields),
      }),
      deps(),
    );
    return answered!;
  }

  /** The Composio page's form: the accounts chosen, each for its service. */
  function postComposio(
    provider: string,
    state: string,
    accounts: Record<string, string>,
    decision = "approve",
  ): Promise<Response> {
    return post(`/connect/${provider}/composio`, {
      state,
      decision,
      ...Object.fromEntries(
        Object.entries(accounts).map(([service, id]) => [
          `account.${service}`,
          id,
        ]),
      ),
    });
  }

  /** The state in the URL of the Gateway page a connect or a Reconnect led to. */
  function stateOf(location: string | null, page: string): string {
    const url = new URL(location!, GATEWAY);
    expect(url.origin + url.pathname).toBe(`${GATEWAY}${page}`);
    return url.searchParams.get("state")!;
  }

  function composioStateOf(response: Response): string {
    expect(response.status).toBe(302);
    return stateOf(response.headers.get("location"), "/oauth/composio");
  }

  function allowStateOf(response: Response): string {
    expect(response.status).toBe(302);
    return stateOf(response.headers.get("location"), "/oauth/app-access");
  }

  /** What the Composio page shows the signed-in person for `state`. */
  function page(state: string, userId: string = owner) {
    return buildComposioContext(personOf(userId), state, {
      now,
      fetchUpstream: upstream,
    });
  }

  async function link(userId: string = owner) {
    const started = await startComposioLink(org(userId), composio.fetch);
    composio.approve(new URL(started.url).searchParams.get("cliKey")!);
    const finished = await finishComposioLink(org(userId), composio.fetch);
    expect(finished.state).toBe(ComposioLinkState.Linked);
  }

  /** The signed-in person connects `app` on the Composio page, with the accounts chosen. */
  async function connectThrough(
    app: string,
    accounts: Record<string, string>,
    provider = "google-workspace",
  ) {
    const state = composioStateOf(
      await browse(`/connect/${provider}?app=${app}`),
    );
    expect((await postComposio(provider, state, accounts)).status).toBe(303);
  }

  /** The signed-in person allows `app` on the Allow page. */
  async function allowOnPage(app: string, provider = "google-workspace") {
    const state = allowStateOf(await browse(`/connect/${provider}?app=${app}`));
    const answered = await post(`/connect/${provider}/allow`, {
      state,
      decision: "approve",
    });
    expect(answered.status).toBe(303);
  }

  /** Every access row, as `person app scopes`, sorted. */
  async function accessRows(): Promise<string[]> {
    const slugs = Object.fromEntries(
      Object.entries(rows).map(([slug, rowId]) => [rowId, slug]),
    );
    const names: Record<string, string> = { [owner]: "ben", [member]: "pat" };
    return (await db.select().from(providerAppAccess))
      .map(
        (row) =>
          `${names[row.userId]} ${slugs[row.appRowId]} ${(JSON.parse(row.scopes) as string[]).join("+")}`,
      )
      .sort();
  }

  /** The owner's connection to a provider as the row holds it, its accounts parsed. */
  async function connectionRow(providerId = "google-workspace") {
    const [row] = await db
      .select()
      .from(providerConnections)
      .where(eq(providerConnections.providerId, providerId));
    if (!row) return null;
    return {
      ...row,
      accounts:
        row.composioAccounts === null
          ? null
          : (JSON.parse(row.composioAccounts) as unknown[]),
    };
  }

  /** The requests Composio received from `mark` on, as `METHOD path` without the query. */
  const requestsFrom = (mark: number) =>
    composio.state.requests
      .slice(mark)
      .map((request) => `${request.method} ${request.path.split("?")[0]}`);

  async function eventsOf(type: string): Promise<Record<string, unknown>[]> {
    return (
      await db
        .select({ data: events.data })
        .from(events)
        .where(eq(events.type, type))
    ).map((row) => JSON.parse(row.data) as Record<string, unknown>);
  }

  /** What `app` still needs of the owner before it opens. */
  function needs(app: string) {
    return connectionNeeds({
      organizationId: acme,
      userId: owner,
      app: { rowId: rows[app]!, slug: app, manifest: APPS[app]!.manifest },
    });
  }

  /** What every step of the Composio page shows for mail. */
  const mailPage = (state: string) => ({
    ok: true,
    state,
    action: "/connect/google-workspace/composio",
    email: "ben@acme.test",
    provider: { id: "google-workspace", name: "Google" },
    app: {
      id: "mail",
      name: "OpenMail",
      hostname: "mail.apps.example.com",
      status: "active",
      icon: null,
    },
    why: "Reads and sends mail.",
  });

  describe("GET /connect/<id>?app=<app>, for a provider with no client", () => {
    it("says the provider has no client while Composio is off, and for an app that lists a scope no service covers", async () => {
      await setComposio(org(owner), false);
      const off = await browse("/connect/google-workspace?app=mail");
      expect(off.status).toBe(409);
      expect(await off.text()).toContain(`Google ${NO_CLIENT}`);

      await setComposio(org(owner), true);
      // people lists `contacts.readonly`, which is no service's in Composio.
      const uncovered = await browse("/connect/google-workspace?app=people");
      expect(uncovered.status).toBe(409);
      expect(await uncovered.text()).toContain(`Google ${NO_CLIENT}`);

      expect(await db.select().from(oauthStates)).toEqual([]);
      expect(composio.state.requests).toEqual([]);
    });

    it("leads to the Gateway's Composio page with a one-use state, and asks nothing of a provider or of Composio", async () => {
      const state = composioStateOf(
        await browse(
          `/connect/google-workspace?app=mail&return=${encodeURIComponent(MAIL)}`,
        ),
      );
      expect(await db.select().from(oauthStates)).toMatchObject([
        {
          state,
          providerId: "google-workspace",
          organizationId: acme,
          userId: owner,
          appRowId: rows["mail"],
          purpose: "composio",
          codeVerifier: "",
          scopes: JSON.stringify(["gmail.modify"]),
          returnTo: MAIL,
        },
      ]);
      expect(composio.state.requests).toEqual([]);
      expect(providerRequests).toEqual([]);
    });
  });

  describe("the Composio page", () => {
    it("asks a person who hasn't linked to sign in to Composio, going by their own link and not a colleague's", async () => {
      await link(member);
      const state = composioStateOf(
        await browse("/connect/google-workspace?app=mail"),
      );
      const mark = composio.state.requests.length;
      expect(await page(state)).toEqual({ ...mailPage(state), step: "link" });
      expect(requestsFrom(mark)).toEqual([]);
    });

    it("names a service the app needs that isn't connected in their Composio, with its page there, and moves on once it is", async () => {
      await link();
      const state = composioStateOf(
        await browse("/connect/google-workspace?app=seo"),
      );
      expect(await page(state)).toMatchObject({
        ok: true,
        app: { id: "seo", name: "OpenSEO" },
        step: "missing",
        missing: [
          {
            slug: "google_search_console",
            label: "Search Console",
            url: "https://dashboard.composio.dev/~/~/connect/apps/google_search_console",
          },
        ],
      });
      // They connect it in Composio and select Check again: the same page,
      // read from Composio again.
      composio.state.accounts.push(SITES);
      expect(await page(state)).toMatchObject({
        step: "allow",
        services: [
          {
            slug: "google_search_console",
            label: "Search Console",
            accounts: [{ id: "ca_sites", account: "alex@gmail.test" }],
            chosen: "ca_sites",
          },
        ],
      });
    });

    it("asks to allow once every service is there: each with its accounts to choose from, the one the connection uses now chosen", async () => {
      await link();
      const state = composioStateOf(
        await browse("/connect/google-workspace?app=mail"),
      );
      const context = await page(state);
      expect(context).toEqual({
        ...mailPage(state),
        step: "allow",
        // Gmail alone: what mail lists needs no other service.
        services: [
          {
            slug: "gmail",
            label: "Gmail",
            accounts: [
              { id: "ca_alex", account: "alex@gmail.test" },
              { id: "ca_work", account: "work@gmail.test" },
            ],
            chosen: "ca_alex",
          },
        ],
      });
      expect(JSON.stringify(context)).not.toContain(composio.state.key);
      // Reading spends nothing: the page's form still has its state to post.
      expect(await db.select().from(oauthStates)).toHaveLength(1);

      // They choose the second account. A page opened after that starts
      // from it.
      expect(
        (await postComposio("google-workspace", state, { gmail: "ca_work" }))
          .status,
      ).toBe(303);
      const again = await startReconnect(googleKey(), {
        fresh: true,
        fetchUpstream: upstream,
      });
      expect(again.outcome).toBe(ReconnectOutcome.Provider);
      if (again.outcome !== ReconnectOutcome.Provider) return;
      expect(await page(stateOf(again.url, "/oauth/composio"))).toMatchObject({
        step: "allow",
        services: [{ chosen: "ca_work" }],
      });
    });

    it("shows nothing for someone else's state, an app that lists more by now, a provider set up another way since, or while Composio doesn't answer", async () => {
      await link();
      const state = composioStateOf(
        await browse("/connect/google-workspace?app=mail"),
      );
      const gone = { ok: false, message: USED };
      // Pat opens mail too, and linked: the state is Ben's.
      await link(member);
      expect(await page(state, member)).toEqual(gone);
      // An Allow page's state is the Allow page's.
      await OAuthStateRepository.put({
        state: "an-allow-state",
        ...googleKey(),
        appRowId: rows["mail"]!,
        purpose: OAuthStatePurpose.Allow,
        codeVerifier: "",
        scopes: ["gmail.modify"],
        returnTo: MAIL,
        now: new Date(now),
      });
      expect(await page("an-allow-state")).toEqual(gone);
      await OAuthStateRepository.take("an-allow-state", new Date(now));

      composio.state.intercept = () => new Response("down", { status: 503 });
      expect(await page(state)).toEqual({
        ok: false,
        message: "Composio could not be reached. Try again.",
      });
      composio.state.intercept = null;

      // An admin adds Google's own client: it isn't served through Composio any more.
      await setOAuthClient(org(owner), null, "google-workspace", {
        clientId: "g-client-id",
        clientSecret: "g-client-secret",
      });
      expect(await page(state)).toEqual({
        ok: false,
        message:
          "How Google is set up on this Gateway changed since this page opened. Open OpenMail and connect again.",
      });
      await removeOAuthClient(org(owner), null, "google-workspace");

      // mail is redeployed listing Calendar too: the state holds less.
      await deploy("mail", {
        "google-workspace": {
          scopes: ["gmail.modify", "calendar.events"],
          why: "Reads and sends mail.",
        },
      });
      expect(await page(state)).toEqual(gone);
      // None of those spent it.
      expect(await db.select().from(oauthStates)).toHaveLength(1);
    });
  });

  describe("POST /connect/<id>/composio", () => {
    it("makes the connection from the account chosen, allows the app for the scopes it lists, spends the state and goes back to the app", async () => {
      await link();
      const path = `/connect/google-workspace?app=mail&return=${encodeURIComponent(MAIL)}`;
      const state = composioStateOf(await browse(path));
      const mark = composio.state.requests.length;

      const answered = await postComposio("google-workspace", state, {
        gmail: "ca_work",
      });
      expect(answered.status).toBe(303);
      expect(answered.headers.get("location")).toBe(MAIL);

      const row = (await connectionRow())!;
      expect(row).toMatchObject({
        organizationId: acme,
        providerId: "google-workspace",
        userId: owner,
        via: "composio",
        accounts: [
          { service: "gmail", id: "ca_work", account: "work@gmail.test" },
        ],
        label: "work@gmail.test",
        externalId: "gmail:ca_work",
        scopes: "[]",
        status: "active",
        refreshTokenEnc: null,
        expiresAt: null,
      });
      // No token: the column holds a sealed empty string.
      expect(isSealed(row.accessTokenEnc)).toBe(true);
      expect(
        await ProviderConnectionRepository.readTokens(row.id, fakeEnv),
      ).toMatchObject({ accessToken: "", refreshToken: null });
      expect(await accessRows()).toEqual(["ben mail gmail.modify"]);
      expect(await db.select().from(oauthStates)).toEqual([]);
      // The accounts were read from Composio again, and nothing else was
      // asked of it or of Google.
      expect(requestsFrom(mark)).toEqual(["GET /connected_accounts"]);
      expect(providerRequests).toEqual([]);
      expect(await eventsOf("provider.connected")).toMatchObject([
        {
          provider: { id: "google-workspace", name: "Google" },
          account: { user: { id: owner }, label: "work@gmail.test" },
          app: { id: "mail" },
          scopes: [],
          reconnected: false,
          via: "composio",
        },
      ]);

      // Connected and allowed: the connect link goes straight back to the app.
      const back = await browse(path);
      expect(back.status).toBe(302);
      expect(back.headers.get("location")).toBe(MAIL);
      // The state was spent: the form can't be posted twice.
      const twice = await postComposio("google-workspace", state, {
        gmail: "ca_alex",
      });
      expect(twice.status).toBe(400);
      expect((await connectionRow())!.externalId).toBe("gmail:ca_work");
    });

    it("changes nothing when the person says no, and spends the state", async () => {
      await link();
      const state = composioStateOf(
        await browse(
          `/connect/google-workspace?app=mail&return=${encodeURIComponent(MAIL)}`,
        ),
      );
      const denied = await postComposio(
        "google-workspace",
        state,
        { gmail: "ca_alex" },
        "deny",
      );
      expect(denied.status).toBe(303);
      expect(denied.headers.get("location")).toBe(MAIL);
      expect(await connectionRow()).toBeNull();
      expect(await accessRows()).toEqual([]);
      expect(await db.select().from(oauthStates)).toEqual([]);
    });

    it("refuses and spends another person's state, and another provider's", async () => {
      await link();
      const bens = composioStateOf(
        await browse("/connect/google-workspace?app=mail"),
      );
      signIn(member);
      const foreign = await postComposio("google-workspace", bens, {
        gmail: "ca_alex",
      });
      expect(foreign.status).toBe(400);
      expect(await foreign.text()).toContain("started by someone else");

      signIn(owner);
      const googles = composioStateOf(
        await browse("/connect/google-workspace?app=mail"),
      );
      const elsewhere = await postComposio("github-oauth", googles, {
        github: "ca_octo",
      });
      expect(elsewhere.status).toBe(400);
      expect(await elsewhere.text()).toContain(USED);

      expect(await db.select().from(oauthStates)).toEqual([]);
      expect(await db.select().from(providerConnections)).toEqual([]);
      expect(await accessRows()).toEqual([]);
    });

    it("keeps each page's state to its own form: a composio state is refused by the provider's callback and by the Allow form, an allow state by the Composio form", async () => {
      await link();
      const start = () =>
        browse("/connect/google-workspace?app=mail").then(composioStateOf);

      const callback = await browse(
        `/connect/google-workspace/callback?code=a-code&state=${await start()}`,
      );
      expect(callback.status).toBe(400);
      const allowForm = await post("/connect/google-workspace/allow", {
        state: await start(),
        decision: "approve",
      });
      expect(allowForm.status).toBe(400);
      expect(await db.select().from(providerConnections)).toEqual([]);

      // An Allow page's state, for inbox on the connection mail made.
      await connectThrough("mail", { gmail: "ca_alex" });
      const allowState = allowStateOf(
        await browse("/connect/google-workspace?app=inbox"),
      );
      const composioForm = await postComposio("google-workspace", allowState, {
        gmail: "ca_work",
      });
      expect(composioForm.status).toBe(400);
      expect(await composioForm.text()).toContain(USED);
      // Each was spent by the form that refused it, and nothing changed.
      expect(await db.select().from(oauthStates)).toEqual([]);
      expect((await connectionRow())!.externalId).toBe("gmail:ca_alex");
      expect(await accessRows()).toEqual(["ben mail gmail.modify"]);
      expect(providerRequests).toEqual([]);
    });

    it("refuses an account that isn't in the person's Composio, is of another service, or isn't named", async () => {
      await link();
      for (const accounts of [
        { gmail: "ca_nobody" },
        // GitHub's account, sent as Gmail's.
        { gmail: "ca_octo" },
        // Named for another service than the one the app needs.
        { github: "ca_alex" },
        {},
      ] as Record<string, string>[]) {
        const state = composioStateOf(
          await browse("/connect/google-workspace?app=mail"),
        );
        const refused = await postComposio("google-workspace", state, accounts);
        expect(refused.status).toBe(409);
        expect(await refused.text()).toContain(
          "The accounts in your Composio changed since this page opened. Open OpenMail and connect again.",
        );
      }
      expect(await db.select().from(providerConnections)).toEqual([]);
      expect(await accessRows()).toEqual([]);
      expect(await db.select().from(oauthStates)).toEqual([]);
    });

    it("refuses once the provider gained a client, or Composio was turned off, after the page opened", async () => {
      await link();
      const changed =
        "How Google is set up on this Gateway changed since this page opened. Open OpenMail and connect again.";

      const before = composioStateOf(
        await browse("/connect/google-workspace?app=mail"),
      );
      await setOAuthClient(org(owner), null, "google-workspace", {
        clientId: "g-client-id",
        clientSecret: "g-client-secret",
      });
      const withClient = await postComposio("google-workspace", before, {
        gmail: "ca_alex",
      });
      expect(withClient.status).toBe(409);
      expect(await withClient.text()).toContain(changed);
      await removeOAuthClient(org(owner), null, "google-workspace");

      const open = composioStateOf(
        await browse("/connect/google-workspace?app=mail"),
      );
      await setComposio(org(owner), false);
      const off = await postComposio("google-workspace", open, {
        gmail: "ca_alex",
      });
      expect(off.status).toBe(409);
      expect(await off.text()).toContain(changed);

      expect(await db.select().from(providerConnections)).toEqual([]);
      expect(await accessRows()).toEqual([]);
    });

    it("refuses an app that lists more than the page showed", async () => {
      await link();
      composio.state.accounts.push({
        slug: "googlecalendar",
        id: "ca_cal",
        wordId: "quiet-finch",
      });
      const state = composioStateOf(
        await browse("/connect/google-workspace?app=mail"),
      );
      await deploy("mail", {
        "google-workspace": {
          scopes: ["gmail.modify", "calendar.events"],
          why: "Reads and sends mail.",
        },
      });
      const refused = await postComposio("google-workspace", state, {
        gmail: "ca_alex",
        googlecalendar: "ca_cal",
      });
      expect(refused.status).toBe(409);
      expect(await refused.text()).toContain(
        "OpenMail asks for more than this page showed. Open OpenMail again.",
      );
      expect(await db.select().from(providerConnections)).toEqual([]);
      expect(await accessRows()).toEqual([]);
    });
  });

  describe("a second app", () => {
    it("that needs another service goes to the Composio page, and afterwards the connection holds both services and the first app is still allowed", async () => {
      await link();
      await connectThrough("mail", { gmail: "ca_work" });
      const first = (await connectionRow())!;
      composio.state.accounts.push(SITES);

      const state = composioStateOf(
        await browse("/connect/google-workspace?app=seo"),
      );
      // The page asks for the service seo needs, and no other.
      const context = await page(state);
      expect(
        context.ok && context.step === "allow" ? context.services : context,
      ).toMatchObject([{ slug: "google_search_console" }]);
      const answered = await postComposio("google-workspace", state, {
        google_search_console: "ca_sites",
      });
      expect(answered.status).toBe(303);

      // One connection still, with both services in Google's order.
      expect(await db.select().from(providerConnections)).toHaveLength(1);
      expect(await connectionRow()).toMatchObject({
        id: first.id,
        via: "composio",
        accounts: [
          { service: "gmail", id: "ca_work", account: "work@gmail.test" },
          {
            service: "google_search_console",
            id: "ca_sites",
            account: "alex@gmail.test",
          },
        ],
        label: "work@gmail.test, alex@gmail.test",
        externalId: "gmail:ca_work,google_search_console:ca_sites",
      });
      expect(await accessRows()).toEqual([
        "ben mail gmail.modify",
        "ben seo webmasters.readonly",
      ]);
      expect(await needs("mail")).toEqual([]);
      expect(await needs("seo")).toEqual([]);
    });

    it("that needs a service the connection already has goes to the Allow page, which names the service with its account, and whose form allows it", async () => {
      await link();
      await connectThrough("mail", { gmail: "ca_alex" });
      composio.state.accounts.push(SITES);
      await connectThrough("seo", { google_search_console: "ca_sites" });
      const mark = composio.state.requests.length;

      const state = allowStateOf(
        await browse(
          `/connect/google-workspace?app=inbox&return=${encodeURIComponent(INBOX)}`,
        ),
      );
      expect(
        await buildAppAccessContext(personOf(owner), state, now),
      ).toMatchObject({
        ok: true,
        action: "/connect/google-workspace/allow",
        provider: { id: "google-workspace", name: "Google" },
        app: { id: "inbox", name: "Inbox" },
        account: "alex@gmail.test",
        scopes: ["openid", "gmail.readonly"],
        // The service inbox uses, not Search Console, which seo added.
        composio: [{ label: "Gmail", account: "alex@gmail.test" }],
      });

      const allowed = await post("/connect/google-workspace/allow", {
        state,
        decision: "approve",
      });
      expect(allowed.status).toBe(303);
      expect(allowed.headers.get("location")).toBe(INBOX);
      expect(await accessRows()).toEqual([
        "ben inbox openid+gmail.readonly",
        "ben mail gmail.modify",
        "ben seo webmasters.readonly",
      ]);
      // The Allow page and its form ask nothing of Composio.
      expect(requestsFrom(mark)).toEqual([]);
    });

    it("loses its access when the person chooses another account for a service the connection already had", async () => {
      await link();
      await connectThrough("mail", { gmail: "ca_alex" });
      await allowOnPage("inbox");
      expect(await accessRows()).toHaveLength(2);

      // Reconnect from the row's menu, and the other Gmail account.
      const again = await startReconnect(googleKey(), {
        fresh: true,
        fetchUpstream: upstream,
      });
      if (again.outcome !== ReconnectOutcome.Provider) {
        throw new Error("no page");
      }
      const state = stateOf(again.url, "/oauth/composio");
      const [stored] = await db.select().from(oauthStates);
      // An Allow page left open in another tab shows the account as it was.
      await OAuthStateRepository.put({
        state: "an-open-allow-page",
        ...googleKey(),
        appRowId: rows["seo"]!,
        purpose: OAuthStatePurpose.Allow,
        codeVerifier: "",
        scopes: ["webmasters.readonly"],
        returnTo: null,
        now: new Date(now),
      });
      const answered = await postComposio("google-workspace", state, {
        gmail: "ca_work",
      });
      expect(answered.status).toBe(303);
      expect(answered.headers.get("location")).toBe("/connections/accounts");

      expect(await connectionRow()).toMatchObject({
        externalId: "gmail:ca_work",
        label: "work@gmail.test",
      });
      // Only the app the page was in the name of: the other asks again.
      const access = await db.select().from(providerAppAccess);
      expect(access.map((row) => row.appRowId)).toEqual([stored!.appRowId]);
      // The page in the other tab was spent with it.
      expect(await db.select().from(oauthStates)).toEqual([]);
      expect(await eventsOf("provider.connected")).toMatchObject([
        { reconnected: false },
        { reconnected: true, via: "composio" },
      ]);
    });
  });

  describe("an account gone from the person's Composio", () => {
    it("takes its apps' access when another app's connect drops it, so the account chosen for that service later is never theirs unasked", async () => {
      await link();
      await connectThrough("mail", { gmail: "ca_alex" });
      await allowOnPage("inbox");
      expect(await accessRows()).toEqual([
        "ben inbox openid+gmail.readonly",
        "ben mail gmail.modify",
      ]);

      // Gmail is removed at Composio, and OpenSEO connects Search Console.
      composio.state.accounts = [OCTO, SITES];
      await connectThrough("seo", { google_search_console: "ca_sites" });
      expect((await connectionRow())!.externalId).toBe(
        "google_search_console:ca_sites",
      );
      expect(await accessRows()).toEqual(["ben seo webmasters.readonly"]);

      // Another Gmail account, connected from OpenMail: Inbox asks again.
      composio.state.accounts = [OCTO, SITES, WORK];
      await connectThrough("mail", { gmail: "ca_work" });
      expect((await connectionRow())!.externalId).toBe(
        "gmail:ca_work,google_search_console:ca_sites",
      );
      expect(await accessRows()).toEqual([
        "ben mail gmail.modify",
        "ben seo webmasters.readonly",
      ]);
    });
  });

  describe("Reconnect on Accounts", () => {
    it("turns a connection that expired with a refused key active again on the spot, once the person linked again and its accounts are still there", async () => {
      await link();
      await connectThrough("mail", { gmail: "ca_alex" });
      await allowOnPage("inbox");
      // Ben revoked the key in Composio; the next read notices.
      composio.state.key = "uak_rotatedKey456";
      await composioStatus(org(owner), { list: true }, composio.fetch);
      expect(await db.select().from(composioLinks)).toEqual([]);
      expect(await connectionRow()).toMatchObject({ status: "expired" });
      expect(await needs("mail")).toMatchObject([{ action: "reconnect" }]);

      // Not linked yet: Reconnect leads to the Composio page, to sign in.
      const unlinked = await startReconnect(googleKey(), {
        fetchUpstream: upstream,
      });
      if (unlinked.outcome !== ReconnectOutcome.Provider) {
        throw new Error("no page");
      }
      expect(
        await page(stateOf(unlinked.url, "/oauth/composio")),
      ).toMatchObject({ step: "link" });
      expect(await connectionRow()).toMatchObject({ status: "expired" });

      await link();
      expect(
        await startReconnect(googleKey(), { fetchUpstream: upstream }),
      ).toEqual({ outcome: ReconnectOutcome.Allowed, provider: "Google" });
      expect(await connectionRow()).toMatchObject({
        status: "active",
        externalId: "gmail:ca_alex",
      });
      // No app asks again.
      expect(await accessRows()).toEqual([
        "ben inbox openid+gmail.readonly",
        "ben mail gmail.modify",
      ]);
      expect(await needs("mail")).toEqual([]);
      expect(await needs("inbox")).toEqual([]);
    });

    it("answers the Composio page when an account on the connection is gone from their Composio, and asks nothing while all is well", async () => {
      await link();
      await connectThrough("mail", { gmail: "ca_alex" });
      // Healthy: nothing to ask.
      expect(
        await startReconnect(googleKey(), { fetchUpstream: upstream }),
      ).toEqual({ outcome: ReconnectOutcome.Allowed, provider: "Google" });
      expect(await db.select().from(oauthStates)).toEqual([]);

      // They removed that Gmail account in Composio.
      composio.state.accounts = [WORK, OCTO];
      const gone = await startReconnect(googleKey(), {
        fetchUpstream: upstream,
      });
      if (gone.outcome !== ReconnectOutcome.Provider) {
        throw new Error("no page");
      }
      const state = stateOf(gone.url, "/oauth/composio");
      expect(await db.select().from(oauthStates)).toMatchObject([
        {
          state,
          purpose: "composio",
          appRowId: rows["mail"],
          returnTo: "/connections/accounts",
        },
      ]);
      // The page offers what is there now.
      expect(await page(state)).toMatchObject({
        step: "allow",
        services: [
          {
            slug: "gmail",
            accounts: [{ id: "ca_work", account: "work@gmail.test" }],
            chosen: "ca_work",
          },
        ],
      });
    });

    it("goes through the provider once an admin adds a client: nothing is deleted, the connection reads Reconnect, and the connect that follows takes the other apps' access", async () => {
      await link();
      await connectThrough("crm", { github: "ca_octo" }, "github-oauth");
      await allowOnPage("ci", "github-oauth");
      expect(await accessRows()).toEqual([
        "ben ci repo+workflow",
        "ben crm repo",
      ]);
      expect(await needs("crm")).toEqual([]);

      await setOAuthClient(org(owner), null, "github-oauth", {
        clientId: "gh-client-id",
        clientSecret: "gh-client-secret",
      });
      // Nothing is deleted; the row reads Needs reconnect.
      expect(await connectionRow("github-oauth")).toMatchObject({
        via: "composio",
        status: "active",
      });
      expect(await accessRows()).toHaveLength(2);
      expect(await needs("crm")).toEqual([
        {
          provider: "github-oauth",
          label: "GitHub",
          action: "reconnect",
          connectPath: "/connect/github-oauth?app=crm",
        },
      ]);
      expect(await listConnections(org(owner))).toMatchObject([
        { providerId: "github-oauth", via: "composio", needsReconnect: true },
      ]);

      // Reconnect, and the app's own connect link, go to GitHub.
      const mark = composio.state.requests.length;
      const result = await startReconnect(keyOf("github-oauth"), {
        fetchUpstream: upstream,
      });
      if (result.outcome !== ReconnectOutcome.Provider) {
        throw new Error("no provider");
      }
      const authorize = new URL(result.url);
      expect(authorize.origin + authorize.pathname).toBe(
        GITHUB.auth.authorizeUrl,
      );
      const fromApp = await browse("/connect/github-oauth?app=crm");
      expect(fromApp.headers.get("location")).toContain(
        GITHUB.auth.authorizeUrl,
      );
      const [stored] = await db
        .select()
        .from(oauthStates)
        .where(eq(oauthStates.state, authorize.searchParams.get("state")!));

      const finished = await browse(
        github.authorize(result.url).toString().slice(GATEWAY.length),
      );
      expect(finished.status).toBe(302);
      expect(await connectionRow("github-oauth")).toMatchObject({
        via: "oauth",
        label: "ben",
        accounts: null,
        status: "active",
      });
      // To the Gateway that is another account: only the app the
      // reconnect was in the name of is allowed, and the other asks again.
      const access = await db.select().from(providerAppAccess);
      expect(access.map((row) => row.appRowId)).toEqual([stored!.appRowId]);
      expect(await listConnections(org(owner))).toMatchObject([
        { via: "oauth", services: [], needsReconnect: false },
      ]);
      // Composio saw none of it.
      expect(requestsFrom(mark)).toEqual([]);
    });

    it("goes through Composio once the client a connection was made with is removed, while Composio is on", async () => {
      await setOAuthClient(org(owner), null, "github-oauth", {
        clientId: "gh-client-id",
        clientSecret: "gh-client-secret",
      });
      const started = await browse("/connect/github-oauth?app=crm");
      await browse(
        github
          .authorize(started.headers.get("location")!)
          .toString()
          .slice(GATEWAY.length),
      );
      await allowOnPage("ci", "github-oauth");
      const made = (await connectionRow("github-oauth"))!;
      expect(made).toMatchObject({ via: "oauth", label: "ben" });

      await removeOAuthClient(org(owner), null, "github-oauth");
      // Nothing is deleted; the row reads Needs reconnect.
      expect(await accessRows()).toHaveLength(2);
      expect(await needs("crm")).toMatchObject([{ action: "reconnect" }]);
      expect(await listConnections(org(owner))).toMatchObject([
        { via: "oauth", needsReconnect: true },
      ]);

      await link();
      const result = await startReconnect(keyOf("github-oauth"), {
        fetchUpstream: upstream,
      });
      if (result.outcome !== ReconnectOutcome.Provider) {
        throw new Error("no page");
      }
      const state = stateOf(result.url, "/oauth/composio");
      const [stored] = await db.select().from(oauthStates);
      const answered = await postComposio("github-oauth", state, {
        github: "ca_octo",
      });
      expect(answered.status).toBe(303);
      expect(await connectionRow("github-oauth")).toMatchObject({
        id: made.id,
        via: "composio",
        label: "brave-otter",
        accounts: [
          { service: "github", id: "ca_octo", account: "brave-otter" },
        ],
      });
      const access = await db.select().from(providerAppAccess);
      expect(access.map((row) => row.appRowId)).toEqual([stored!.appRowId]);
    });

    it("says an owner or admin sets the provider up when it has no client and Composio is off", async () => {
      await setOAuthClient(org(owner), null, "github-oauth", {
        clientId: "gh-client-id",
        clientSecret: "gh-client-secret",
      });
      const started = await browse("/connect/github-oauth?app=crm");
      await browse(
        github
          .authorize(started.headers.get("location")!)
          .toString()
          .slice(GATEWAY.length),
      );
      await removeOAuthClient(org(owner), null, "github-oauth");
      await setComposio(org(owner), false);
      await expect(
        startReconnect(keyOf("github-oauth"), { fetchUpstream: upstream }),
      ).rejects.toMatchObject({ code: "OAUTH_CLIENT_REQUIRED" });
    });
  });

  describe("what an app needs of a person, for a provider served through Composio", () => {
    it("is Connect with no connection, nothing once connected and allowed, Allow for an app whose service the connection has, and Reconnect for one whose service it lacks or once it expired", async () => {
      const need = (action: string, app: string) => [
        {
          provider: "google-workspace",
          label: "Google",
          action,
          connectPath: `/connect/google-workspace?app=${app}`,
        },
      ];
      expect(await needs("mail")).toEqual(need("connect", "mail"));

      await link();
      await connectThrough("mail", { gmail: "ca_alex" });
      expect(await needs("mail")).toEqual([]);
      expect(await needs("inbox")).toEqual(need("allow", "inbox"));
      expect(await needs("seo")).toEqual(need("reconnect", "seo"));

      await ProviderConnectionRepository.markExpired(
        (await connectionRow())!.id,
      );
      expect(await needs("mail")).toEqual(need("reconnect", "mail"));
    });
  });

  describe("the setup gate", () => {
    /** The report the launcher, the app lists and the gate read for an app. */
    const report = (app: string, organizationId: string | undefined = acme) =>
      appSettingsReport({
        rowId: rows[app]!,
        versionId: `${app}-version`,
        secretNames: null,
        appId: app,
        tier: "service_binding",
        manifest: APPS[app]!.manifest,
        ...(organizationId === undefined ? {} : { organizationId }),
        canFix: true,
      });
    const unmet = async (app: string, organizationId?: string) =>
      (await report(app, organizationId))!.unmet.map((setting) => setting.id);

    it("counts a required OAuth provider with no client as set up when Composio is on and has a service for every scope the app lists", async () => {
      expect(await report("mail")).toMatchObject({ ready: true, unmet: [] });
      resetAppSetupCacheForTests();
      expect(await report("crm")).toMatchObject({ ready: true, unmet: [] });
      resetAppSetupCacheForTests();
      // `contacts.readonly` maps to no service: for people, Google needs an OAuth app.
      expect(await report("people")).toMatchObject({ ready: false });
      expect(await unmet("people")).toEqual(["google-workspace"]);
      resetAppSetupCacheForTests();
      // Another organization's switch is its own.
      expect(await unmet("mail", "org-elsewhere")).toEqual([
        "google-workspace",
      ]);
    });

    it("never counts it for a remote MCP app: its server is reached with a token the Gateway holds, so its provider needs a client", async () => {
      const remote = await appSettingsReport({
        rowId: "row-remote",
        versionId: null,
        secretNames: null,
        appId: "tracker",
        tier: "provider",
        manifest: {
          id: "tracker",
          name: "Tracker",
          description: "A remote MCP server.",
          remote: {
            url: "https://mcp.tracker.example/mcp",
            auth: { kind: "provider", provider: "github-oauth" },
            risk: "write",
            tools: {},
            rev: 1,
          },
          capabilities: { "github-oauth": { scopes: ["repo"] } },
        },
        organizationId: acme,
        canFix: true,
      });
      expect(remote).toMatchObject({ ready: false });
      expect(remote!.unmet.map((setting) => setting.id)).toEqual([
        "github-oauth",
      ]);
    });

    it("keeps the app closed while Composio is off, and opens it as soon as an owner turns it on", async () => {
      await setComposio(org(owner), false);
      resetAppSetupCacheForTests();
      expect(await report("mail")).toMatchObject({ ready: false });
      expect(await unmet("mail")).toEqual(["google-workspace"]);
      // Turned on: read at once, with nothing reset in between.
      await setComposio(org(owner), true);
      expect(await report("mail")).toMatchObject({ ready: true, unmet: [] });
      await setComposio(org(owner), false);
      expect(await unmet("mail")).toEqual(["google-workspace"]);
    });
  });

  describe("the lists", () => {
    it("say a provider served through Composio is configured, that it is served that way, and which apps it still keeps closed", async () => {
      const google = async () =>
        (await listProviders(org(owner))).find(
          (each) => each.id === "google-workspace",
        );
      /** The apps Google keeps closed, by name. */
      const closed = async () =>
        (await google())!.apps
          .filter((app) => app.needs)
          .map((app) => app.name)
          .sort();
      expect(await google()).toMatchObject({
        configured: true,
        oauth: { bound: false, composio: true, client: { source: null } },
      });
      // People lists a scope no service covers: for it Google needs an OAuth app.
      expect(await closed()).toEqual(["People"]);

      // With the Gateway's own client it is served with that.
      await setOAuthClient(org(owner), null, "google-workspace", {
        clientId: "g-client-id",
        clientSecret: "g-client-secret",
      });
      expect(await google()).toMatchObject({
        configured: true,
        oauth: { bound: true, composio: false, client: { source: "d1" } },
      });
      await removeOAuthClient(org(owner), null, "google-workspace");

      await setComposio(org(owner), false);
      expect(await google()).toMatchObject({
        configured: false,
        oauth: { bound: false, composio: false },
      });
      expect(await closed()).toEqual([
        "Inbox",
        "OpenMail",
        "OpenSEO",
        "People",
      ]);
    });

    it("give each connection's `via`, the services of one made through Composio with their accounts, and whether it needs a reconnect", async () => {
      await link();
      await connectThrough("mail", { gmail: "ca_work" });
      composio.state.accounts.push(SITES);
      await connectThrough("seo", { google_search_console: "ca_sites" });
      expect(await listConnections(org(owner))).toMatchObject([
        {
          providerId: "google-workspace",
          providerName: "Google",
          userId: owner,
          apps: [
            { id: "mail", name: "OpenMail" },
            { id: "seo", name: "OpenSEO" },
          ],
          label: "work@gmail.test, alex@gmail.test",
          via: "composio",
          scopes: [],
          services: [
            { name: "Gmail", account: "work@gmail.test" },
            { name: "Search Console", account: "alex@gmail.test" },
          ],
          status: "active",
          needsReconnect: false,
          // It holds services, not scopes: nothing reads as granted in part.
          permissions: null,
        },
      ]);

      // mail lists Calendar too by now, which the connection doesn't hold.
      await deploy("mail", {
        "google-workspace": {
          scopes: ["gmail.modify", "calendar.events"],
          why: "Reads and sends mail.",
        },
      });
      expect(await listConnections(org(owner))).toMatchObject([
        { via: "composio", needsReconnect: true },
      ]);
    });
  });

  describe("a disconnect", () => {
    it("removes the connection with every app's access, revokes nothing at the provider, calls nothing at Composio and leaves the link", async () => {
      await link();
      await connectThrough("mail", { gmail: "ca_alex" });
      await allowOnPage("inbox");
      const mark = composio.state.requests.length;

      const result = await disconnect(
        org(owner),
        null,
        { providerId: "google-workspace" },
        upstream,
      );
      expect(result).toMatchObject({
        removed: true,
        revoked: false,
        connection: { via: "composio", label: "alex@gmail.test" },
      });
      expect(await db.select().from(providerConnections)).toEqual([]);
      expect(await accessRows()).toEqual([]);
      // Google's preset names a revoke endpoint: nothing was sent to it.
      expect(providerRequests).toEqual([]);
      expect(requestsFrom(mark)).toEqual([]);
      expect(await db.select().from(composioLinks)).toHaveLength(1);
      expect(await eventsOf("provider.disconnected")).toMatchObject([
        {
          provider: { id: "google-workspace" },
          account: { label: "alex@gmail.test" },
          revoked: false,
          via: "composio",
        },
      ]);
      // The app asks again, on the Composio page.
      expect(await needs("mail")).toMatchObject([{ action: "connect" }]);
    });
  });
});
