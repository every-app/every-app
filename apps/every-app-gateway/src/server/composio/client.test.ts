/**
 * The Composio client against the fake (src/test/fake-composio.ts): each
 * call's request and parsed answer, every usable account of a service, a
 * session opened for named accounts, the three kinds of body, every
 * failure by slug and status, timeouts, ids with a shape that can't enter
 * a URL, paging, and that nothing of an account but its id and its name
 * leaves the list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeComposio, type FakeComposio } from "@/test/fake-composio";
import {
  ComposioBodyKind,
  ComposioFailure,
  SignInState,
  composioClient,
  composioSignInUrl,
  type ComposioClient,
  type ComposioCredentials,
} from "./client";

let composio: FakeComposio;
let client: ComposioClient;
let credentials: ComposioCredentials;
let logged: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  composio = fakeComposio();
  client = composioClient(composio.fetch);
  credentials = {
    key: composio.state.key,
    orgId: composio.state.orgId,
    projectId: composio.state.projectId,
    userId: composio.state.userId,
  };
  logged = [
    vi.spyOn(console, "log").mockImplementation(() => undefined),
    vi.spyOn(console, "warn").mockImplementation(() => undefined),
  ];
});

afterEach(() => {
  vi.restoreAllMocks();
});

function lastRequest() {
  return composio.state.requests.at(-1)!;
}

/** Everything written to the console, as one string. */
function logLines(): string {
  return logged
    .flatMap((spy) => spy.mock.calls.map((call) => String(call[0])))
    .join("\n");
}

/** A session for the one GitHub account the session tests connect. */
async function session(): Promise<string> {
  const opened = await client.openSession(credentials, { github: "ca_0" });
  if (!opened.ok) throw new Error("no session");
  return opened.value;
}

describe("the sign-in", () => {
  it("creates one with no key and answers its id and when it expires", async () => {
    const created = await client.createSignIn();

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(composio.state.signIns.has(created.value.id)).toBe(true);
    expect(created.value.expiresAt).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect(lastRequest()).toMatchObject({
      method: "POST",
      path: "/cli/create-session",
      body: { scope: "user", source: "EveryApp" },
    });
    expect(lastRequest().headers["content-type"]).toBe("application/json");
    expect(lastRequest().headers).not.toHaveProperty("x-user-api-key");
    expect(composioSignInUrl(created.value.id)).toBe(
      `https://dashboard.composio.dev/?cliKey=${created.value.id}`,
    );
  });

  it("reads one in each state: pending, linked once with the key and the account, used, gone", async () => {
    const created = await client.createSignIn();
    if (!created.ok) throw new Error("no sign-in");
    const { id } = created.value;

    expect(await client.readSignIn(id)).toEqual({
      ok: true,
      value: { state: SignInState.Pending },
    });
    expect(lastRequest()).toMatchObject({
      method: "GET",
      path: `/cli/get-session?id=${id}`,
    });
    expect(lastRequest().headers).not.toHaveProperty("x-user-api-key");

    composio.approve(id);
    expect(await client.readSignIn(id)).toEqual({
      ok: true,
      value: {
        state: SignInState.Linked,
        key: composio.state.key,
        account: "alex@example.com",
      },
    });
    // The key is handed out once.
    expect(await client.readSignIn(id)).toEqual({
      ok: true,
      value: { state: SignInState.Used },
    });

    composio.expire(id);
    expect(await client.readSignIn(id)).toEqual({
      ok: true,
      value: { state: SignInState.Gone },
    });
  });

  it("names the account by its name when it has no email, and fails when it has neither", async () => {
    composio.state.account.email = undefined;
    const first = await client.createSignIn();
    if (!first.ok) throw new Error("no sign-in");
    composio.approve(first.value.id);
    expect(await client.readSignIn(first.value.id)).toMatchObject({
      value: { state: SignInState.Linked, account: "Alex" },
    });

    composio.state.account.name = undefined;
    const second = await client.createSignIn();
    if (!second.ok) throw new Error("no sign-in");
    composio.approve(second.value.id);
    expect(await client.readSignIn(second.value.id)).toEqual({
      ok: false,
      failure: ComposioFailure.UpstreamFailure,
    });
  });

  it("never sends an id with a shape that can't enter a URL", async () => {
    for (const id of ["", "a b", "a/b", "a?b=c", "../x", "a&id=b"]) {
      expect(await client.readSignIn(id)).toEqual({
        ok: false,
        failure: ComposioFailure.UpstreamFailure,
      });
    }
    expect(composio.state.requests).toHaveLength(0);
  });

  it("answers an upstream failure for a 404 with another slug, a 500 and an answer in another shape", async () => {
    for (const answer of [
      composio.refusal(404, "Route_NotFound", 1000),
      composio.refusal(500, "Internal", 1),
      Response.json({ status: "approved" }),
      new Response("<html>", { status: 200 }),
    ]) {
      composio.state.intercept = () => answer;
      expect(await client.readSignIn("abc")).toEqual({
        ok: false,
        failure: ComposioFailure.UpstreamFailure,
      });
    }
    composio.state.intercept = () =>
      composio.refusal(401, "UserApiKey_Unauthorized", 1801);
    // No key was sent, so none was refused.
    expect(await client.createSignIn()).toEqual({
      ok: false,
      failure: ComposioFailure.UpstreamFailure,
    });
  });
});

describe("the organization and the consumer project", () => {
  it("reads the organization with the key, and nothing else of the answer", async () => {
    expect(await client.readOrganization(composio.state.key)).toEqual({
      ok: true,
      value: "ok_AbC123",
    });
    expect(lastRequest()).toMatchObject({
      method: "GET",
      path: "/auth/session/info",
      body: undefined,
    });
    expect(lastRequest().headers["x-user-api-key"]).toBe(composio.state.key);
  });

  it("resolves the consumer project and user with the key and the organization", async () => {
    expect(
      await client.resolveConsumer(composio.state.key, "ok_AbC123"),
    ).toEqual({
      ok: true,
      value: { projectId: "pr_XyZ789", userId: composio.state.userId },
    });
    expect(lastRequest()).toMatchObject({
      method: "POST",
      path: "/org/consumer/project/resolve",
      body: undefined,
    });
    expect(lastRequest().headers).toMatchObject({
      "x-user-api-key": composio.state.key,
      "x-org-id": "ok_AbC123",
    });
    expect(lastRequest().headers).not.toHaveProperty("content-type");
  });

  it("answers key refused for a wrong key, and for a 401 with any other slug", async () => {
    expect(await client.readOrganization("uak_wrong")).toEqual({
      ok: false,
      failure: ComposioFailure.KeyRefused,
    });
    // The wrong organization answers 401 Auth_Unauthorized.
    expect(
      await client.resolveConsumer(composio.state.key, "ok_Other"),
    ).toEqual({ ok: false, failure: ComposioFailure.KeyRefused });
  });

  it("refuses an organization id from Composio that can't go in a header, and an answer whose ids can't", async () => {
    expect(
      await client.resolveConsumer(composio.state.key, "ok_AbC\r\nx-evil: 1"),
    ).toEqual({ ok: false, failure: ComposioFailure.UpstreamFailure });
    expect(composio.state.requests).toHaveLength(0);

    composio.state.orgId = "ok/../x";
    expect(await client.readOrganization(composio.state.key)).toEqual({
      ok: false,
      failure: ComposioFailure.UpstreamFailure,
    });
    composio.state.orgId = "ok_AbC123";
    composio.state.projectId = "pr XyZ";
    expect(
      await client.resolveConsumer(composio.state.key, "ok_AbC123"),
    ).toEqual({ ok: false, failure: ComposioFailure.UpstreamFailure });
  });
});

describe("the connected accounts", () => {
  it("asks for the slugs given and answers every usable account, several of one service included, in Composio's order", async () => {
    composio.state.accounts = [
      { slug: "slack", wordId: "calm-otter", status: "EXPIRED" },
      { slug: "gmail", wordId: "red-fox", displayName: "alex@example.com" },
      { slug: "github", wordId: "blue-jay", alias: "work" },
      { slug: "gmail", wordId: "grey-owl", displayName: "second@example.com" },
      { slug: "slack", wordId: "tall-elk", disabled: true },
      { slug: "slack", wordId: "wise-hen", displayName: "" },
      { slug: "notion", wordId: "pale-ant", displayName: { not: "a string" } },
      // Not asked for: never listed.
      { slug: "salesforce", wordId: "odd-eel", displayName: "crm" },
      // An id that couldn't name the account in a session: left out.
      { slug: "gmail", id: "ca/../9", wordId: "bad-id" },
    ];

    expect(
      await client.listAccounts(credentials, [
        "github",
        "gmail",
        "slack",
        "notion",
      ]),
    ).toEqual({
      ok: true,
      value: [
        { slug: "gmail", id: "ca_1", account: "alex@example.com" },
        { slug: "github", id: "ca_2", account: "work" },
        // The second Gmail account, with its own id.
        { slug: "gmail", id: "ca_3", account: "second@example.com" },
        { slug: "slack", id: "ca_5", account: "wise-hen" },
        { slug: "notion", id: "ca_6", account: "pale-ant" },
      ],
    });
    expect(lastRequest()).toMatchObject({
      method: "GET",
      path:
        `/connected_accounts?user_ids=${composio.state.userId}` +
        "&statuses=ACTIVE&toolkit_slugs=github,gmail,slack,notion&limit=100",
    });
    expect(lastRequest().headers).toMatchObject({
      "x-user-api-key": composio.state.key,
      "x-org-id": "ok_AbC123",
      "x-project-id": "pr_XyZ789",
    });
  });

  it("lets nothing of `data`, `state` or `auth_config` out", async () => {
    composio.state.accounts = [
      { slug: "gmail", wordId: "red-fox", displayName: "alex@example.com" },
    ];
    const listed = await client.listAccounts(credentials, ["gmail"]);

    expect(JSON.stringify(listed)).not.toMatch(
      /secret|access_token|scope|ac_secret_config|refresh_token/,
    );
    expect(listed).toEqual({
      ok: true,
      value: [{ slug: "gmail", id: "ca_0", account: "alex@example.com" }],
    });
  });

  it("lists an account Composio repeats on a later page once", async () => {
    composio.state.pageSize = 1;
    composio.state.accounts = [
      { slug: "gmail", id: "ca_same", wordId: "red-fox" },
      { slug: "gmail", id: "ca_same", wordId: "red-fox" },
    ];
    expect(await client.listAccounts(credentials, ["gmail"])).toEqual({
      ok: true,
      value: [{ slug: "gmail", id: "ca_same", account: "red-fox" }],
    });
  });

  it("follows the cursor, and stops after five pages", async () => {
    composio.state.pageSize = 1;
    composio.state.accounts = [
      "gmail",
      "github",
      "slack",
      "notion",
      "linear",
      "zoom",
      "dropbox",
    ].map((slug) => ({ slug, wordId: `${slug}-word` }));
    const slugs = composio.state.accounts.map((account) => account.slug);

    const listed = await client.listAccounts(credentials, slugs);

    expect(listed.ok && listed.value.map((each) => each.slug)).toEqual([
      "gmail",
      "github",
      "slack",
      "notion",
      "linear",
    ]);
    expect(composio.state.requests.map((request) => request.path)).toEqual([
      expect.not.stringContaining("cursor="),
      expect.stringContaining("&cursor=2"),
      expect.stringContaining("&cursor=3"),
      expect.stringContaining("&cursor=4"),
      expect.stringContaining("&cursor=5"),
    ]);
  });

  it("fails as the page that failed did, and never sends ids or slugs with another shape", async () => {
    composio.state.pageSize = 1;
    composio.state.accounts = [
      { slug: "gmail", wordId: "red-fox" },
      { slug: "github", wordId: "blue-jay" },
    ];
    composio.state.intercept = (request) =>
      request.path.includes("cursor=2")
        ? composio.refusal(401, "UserApiKey_Unauthorized", 1801)
        : undefined;
    expect(await client.listAccounts(credentials, ["gmail", "github"])).toEqual(
      { ok: false, failure: ComposioFailure.KeyRefused },
    );

    composio.state.requests.length = 0;
    expect(await client.listAccounts(credentials, ["gmail&x=1"])).toEqual({
      ok: false,
      failure: ComposioFailure.UpstreamFailure,
    });
    expect(
      await client.listAccounts({ ...credentials, userId: "consumer x" }, [
        "gmail",
      ]),
    ).toEqual({ ok: false, failure: ComposioFailure.UpstreamFailure });
    expect(composio.state.requests).toHaveLength(0);
  });
});

describe("a session and a request through it", () => {
  beforeEach(() => {
    composio.state.accounts = [{ slug: "github", wordId: "blue-jay" }];
  });

  it("opens a session for the consumer user that names one account per service", async () => {
    composio.state.accounts.push(
      { slug: "gmail", wordId: "red-fox" },
      { slug: "gmail", wordId: "grey-owl" },
    );
    expect(
      await client.openSession(credentials, { github: "ca_0", gmail: "ca_2" }),
    ).toEqual({ ok: true, value: "trs_Fake0001" });
    expect(lastRequest()).toMatchObject({
      method: "POST",
      path: "/tool_router/session",
    });
    // Exactly these accounts, each as Composio takes it: a list of one.
    expect(lastRequest().body).toEqual({
      user_id: composio.state.userId,
      connected_accounts: { github: ["ca_0"], gmail: ["ca_2"] },
    });
    expect(lastRequest().headers).toMatchObject({
      "content-type": "application/json",
      "x-user-api-key": composio.state.key,
      "x-org-id": "ok_AbC123",
      "x-project-id": "pr_XyZ789",
    });
  });

  it("opens no session for no account, or for a service or an account id in another shape, without asking Composio", async () => {
    for (const accounts of [
      {},
      { github: "" },
      { github: "ca 0" },
      { github: "ca_0/../ca_1" },
      { "git hub": "ca_0" },
      { github: "ca_0", "gmail,slack": "ca_1" },
    ] as Record<string, string>[]) {
      expect(await client.openSession(credentials, accounts)).toEqual({
        ok: false,
        failure: ComposioFailure.UpstreamFailure,
      });
    }
    expect(composio.state.requests).toHaveLength(0);
  });

  it("is refused a session for an account that is gone from the person's Composio", async () => {
    expect(await client.openSession(credentials, { github: "ca_9" })).toEqual({
      ok: false,
      failure: ComposioFailure.UpstreamFailure,
    });
    expect(composio.state.sessions.size).toBe(0);
  });

  it("refuses a session id from Composio in another shape", async () => {
    composio.state.intercept = () =>
      Response.json({ session_id: "sess/../1" }, { status: 201 });
    expect(await client.openSession(credentials, { github: "ca_0" })).toEqual({
      ok: false,
      failure: ComposioFailure.UpstreamFailure,
    });
    composio.state.intercept = null;
    composio.state.requests.length = 0;
    for (const sessionId of ["abc", "trs_", "trs_a/b", "trs_a?x"]) {
      expect(
        await client.proxyExecute(credentials, sessionId, {
          toolkit: "github",
          method: "GET",
          url: "https://api.github.com/user",
          headers: [],
        }),
      ).toEqual({ ok: false, failure: ComposioFailure.UpstreamFailure });
    }
    expect(composio.state.requests).toHaveLength(0);
  });

  it("sends a GET with its query and headers, and answers the provider's status, headers and JSON", async () => {
    const sessionId = await session();
    composio.state.provider = () => ({
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        etag: 'W/"abc"',
        "x-not-text": 12,
      },
      data: [{ id: 1, name: "repo" }],
    });

    const answer = await client.proxyExecute(credentials, sessionId, {
      toolkit: "github",
      method: "GET",
      url: "https://api.github.com/user/repos?per_page=2&sort=updated&tag=a&tag=b",
      headers: [
        ["accept", "application/vnd.github+json"],
        ["if-none-match", 'W/"abc"'],
      ],
    });

    expect(answer).toEqual({
      ok: true,
      value: {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          etag: 'W/"abc"',
        },
        body: { kind: ComposioBodyKind.Json, value: [{ id: 1, name: "repo" }] },
      },
    });
    expect(lastRequest()).toMatchObject({
      method: "POST",
      path: `/tool_router/session/${sessionId}/proxy_execute`,
      body: {
        toolkit_slug: "github",
        endpoint:
          "https://api.github.com/user/repos?per_page=2&sort=updated&tag=a&tag=b",
        method: "GET",
        parameters: [
          {
            name: "accept",
            value: "application/vnd.github+json",
            type: "header",
          },
          { name: "if-none-match", value: 'W/"abc"', type: "header" },
        ],
      },
    });
    expect(lastRequest().body).not.toHaveProperty("body");
    expect(lastRequest().headers).toMatchObject({
      "x-user-api-key": composio.state.key,
      "x-org-id": "ok_AbC123",
      "x-project-id": "pr_XyZ789",
    });
  });

  it("sends a POST's JSON body as a value", async () => {
    const sessionId = await session();
    await client.proxyExecute(credentials, sessionId, {
      toolkit: "github",
      method: "POST",
      url: "https://api.github.com/user/repos",
      headers: [],
      body: { name: "new", private: false, topics: [] },
    });

    expect(composio.state.proxyCalls.at(-1)).toMatchObject({
      method: "POST",
      body: { name: "new", private: false, topics: [] },
    });
  });

  it("answers text as text, an empty 304 included, and the provider's own error with its status", async () => {
    const sessionId = await session();
    const request = {
      toolkit: "github",
      method: "GET" as const,
      url: "https://api.github.com/zen",
      headers: [],
    };

    composio.state.provider = () => ({
      status: 200,
      headers: { "content-type": "text/plain" },
      data: "Keep it logically awesome.",
    });
    expect(
      await client.proxyExecute(credentials, sessionId, request),
    ).toMatchObject({
      value: {
        status: 200,
        body: {
          kind: ComposioBodyKind.Text,
          text: "Keep it logically awesome.",
        },
      },
    });

    composio.state.provider = () => ({ status: 304, data: "" });
    expect(
      await client.proxyExecute(credentials, sessionId, request),
    ).toMatchObject({
      value: { status: 304, body: { kind: ComposioBodyKind.Text, text: "" } },
    });

    composio.state.provider = () => ({
      status: 404,
      data: { message: "Not Found" },
    });
    expect(
      await client.proxyExecute(credentials, sessionId, request),
    ).toMatchObject({
      ok: true,
      value: {
        status: 404,
        body: { kind: ComposioBodyKind.Json, value: { message: "Not Found" } },
      },
    });
  });

  it("answers a binary body as its link, content type and size", async () => {
    const sessionId = await session();
    const link = composio.store(
      "avatar.png",
      new Uint8Array([1, 2, 3]),
      "image/png",
    );
    composio.state.provider = () => ({
      status: 200,
      headers: { "content-type": "image/png" },
      binary: link,
    });

    expect(
      await client.proxyExecute(credentials, sessionId, {
        toolkit: "github",
        method: "GET",
        url: "https://api.github.com/avatar",
        headers: [],
      }),
    ).toMatchObject({
      value: {
        status: 200,
        body: {
          kind: ComposioBodyKind.Binary,
          url: link.url,
          contentType: "image/png",
          size: 3,
        },
      },
    });
  });

  it("maps each of Composio's failures by slug and status", async () => {
    const sessionId = await session();
    const request = {
      toolkit: "github",
      method: "GET" as const,
      url: "https://api.github.com/user",
      headers: [],
    };

    // A service the session names no account for.
    expect(
      await client.proxyExecute(credentials, sessionId, {
        ...request,
        toolkit: "slack",
      }),
    ).toEqual({ ok: false, failure: ComposioFailure.NotConnected });

    // The account the session names went since: never sent with another.
    const [gone] = composio.state.accounts;
    composio.state.accounts = [
      { slug: "github", id: "ca_other", wordId: "tall-elk" },
    ];
    expect(await client.proxyExecute(credentials, sessionId, request)).toEqual({
      ok: false,
      failure: ComposioFailure.NotConnected,
    });
    expect(composio.state.proxyCalls).toHaveLength(0);
    composio.state.accounts = [gone!];

    // The host is outside the service's.
    composio.state.domains = { github: ["api.github.com"] };
    expect(
      await client.proxyExecute(credentials, sessionId, {
        ...request,
        url: "https://evil.example/user",
      }),
    ).toEqual({ ok: false, failure: ComposioFailure.HostRefused });

    // The session is gone.
    expect(
      await client.proxyExecute(credentials, "trs_Gone0001", request),
    ).toEqual({ ok: false, failure: ComposioFailure.SessionGone });

    // The key is wrong, and a wrong project answers 401 with another slug.
    expect(
      await client.proxyExecute(
        { ...credentials, key: "uak_wrong" },
        sessionId,
        request,
      ),
    ).toEqual({ ok: false, failure: ComposioFailure.KeyRefused });
    expect(
      await client.proxyExecute(
        { ...credentials, projectId: "pr_Other" },
        sessionId,
        request,
      ),
    ).toEqual({ ok: false, failure: ComposioFailure.KeyRefused });

    // Anything else.
    for (const answer of [
      composio.refusal(500, "Internal", 1),
      composio.refusal(400, "Something_Else", 2),
      composio.refusal(429, "RateLimit", 3),
      new Response("bad gateway", { status: 502 }),
      Response.json({ result_type: "completed", status: "200" }),
      Response.json({ result_type: "completed", status: 99, data: {} }),
    ]) {
      composio.state.intercept = () => answer;
      expect(
        await client.proxyExecute(credentials, sessionId, request),
      ).toEqual({ ok: false, failure: ComposioFailure.UpstreamFailure });
    }
  });
});

describe("an answer larger than the cap", () => {
  it("is refused unread by its length, and cut off by counting when it gives none, so the Worker never holds it whole", async () => {
    const credentials = {
      key: composio.state.key,
      orgId: composio.state.orgId,
      projectId: composio.state.projectId,
      userId: composio.state.userId,
    };
    const failed = { ok: false, failure: ComposioFailure.UpstreamFailure };
    // A list Composio could answer, so only its size refuses it.
    const list = JSON.stringify({ items: [], next_cursor: null });
    composio.state.intercept = () =>
      new Response(list, {
        headers: { "content-length": String(25 * 1024 * 1024 + 1) },
      });
    expect(await client.listAccounts(credentials, ["gmail"])).toEqual(failed);

    // The same list, then more than the cap of spaces, with no length.
    const mebibyte = new Uint8Array(1024 * 1024).fill(32);
    let sent = 0;
    composio.state.intercept = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            sent += 1;
            if (sent === 1) controller.enqueue(new TextEncoder().encode(list));
            else if (sent > 40) controller.close();
            else controller.enqueue(mebibyte);
          },
        }),
      );
    expect(await client.listAccounts(credentials, ["gmail"])).toEqual(failed);
    // It stopped reading at the cap.
    expect(sent).toBeLessThan(40);
  });
});

describe("a binary answer's bytes", () => {
  it("come from Composio's storage host, with redirects refused", async () => {
    const link = composio.store(
      "avatar.png",
      new Uint8Array([7, 8, 9]),
      "image/png",
    );

    const downloaded = await client.download(link);

    expect(downloaded.ok).toBe(true);
    if (!downloaded.ok) return;
    expect(
      new Uint8Array(await new Response(downloaded.value).arrayBuffer()),
    ).toEqual(new Uint8Array([7, 8, 9]));
    expect(lastRequest()).toMatchObject({
      method: "GET",
      url: link.url,
      redirect: "error",
    });
    // Nothing of the person's goes to the storage host.
    expect(lastRequest().headers).not.toHaveProperty("x-user-api-key");
  });

  it("is never fetched from another host, over plain http, or past 25 MB", async () => {
    const link = composio.store("a.bin", new Uint8Array([1]), "image/png");
    for (const refused of [
      { ...link, url: "https://evil.example/a.bin" },
      { ...link, url: "https://r2.cloudflarestorage.com.evil.example/a.bin" },
      { ...link, url: "https://evilr2.cloudflarestorage.com/a.bin" },
      { ...link, url: link.url.replace("https://", "http://") },
      { ...link, url: "not a url" },
      { ...link, size: 25 * 1024 * 1024 + 1 },
    ]) {
      expect(await client.download(refused)).toEqual({
        ok: false,
        failure: ComposioFailure.UpstreamFailure,
      });
    }
    expect(composio.state.requests).toHaveLength(0);

    // At the limit it is.
    expect(
      (await client.download({ ...link, size: 25 * 1024 * 1024 })).ok,
    ).toBe(true);
  });

  it("are cut off at the cap, whatever size the link gave: by the storage host's own length, and by counting what passes", async () => {
    const link = composio.store("a.bin", new Uint8Array([1]), "image/png");
    const mebibyte = new Uint8Array(1024 * 1024);
    // The storage host says the object is larger than the link did.
    composio.state.intercept = () =>
      new Response("x", {
        headers: { "content-length": String(25 * 1024 * 1024 + 1) },
      });
    expect(await client.download(link)).toEqual({
      ok: false,
      failure: ComposioFailure.UpstreamFailure,
    });
    // It gives no length, and sends more than the cap.
    let sent = 0;
    composio.state.intercept = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            sent += 1;
            if (sent > 26) controller.close();
            else controller.enqueue(mebibyte);
          },
        }),
      );
    const streamed = await client.download(link);
    expect(streamed.ok).toBe(true);
    if (!streamed.ok) return;
    await expect(new Response(streamed.value).arrayBuffer()).rejects.toThrow(
      "larger than the cap",
    );
  });

  it("fails on a redirect, a missing object and a fetch that throws", async () => {
    const link = composio.store("a.bin", new Uint8Array([1]), "image/png");
    for (const answer of [
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/" },
      }),
      new Response("gone", { status: 404 }),
    ]) {
      composio.state.intercept = () => answer;
      expect(await client.download(link)).toEqual({
        ok: false,
        failure: ComposioFailure.UpstreamFailure,
      });
    }
    composio.state.intercept = () => {
      throw new TypeError("redirect mode is set to error");
    };
    expect(await client.download(link)).toEqual({
      ok: false,
      failure: ComposioFailure.UpstreamFailure,
    });
  });
});

describe("every request", () => {
  it("has a 30 second timeout, and one that times out is an upstream failure", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await client.readOrganization(composio.state.key);
    expect(timeout).toHaveBeenLastCalledWith(30_000);

    timeout.mockImplementation(() =>
      AbortSignal.abort(new DOMException("timed out", "TimeoutError")),
    );
    const link = composio.store("a.bin", new Uint8Array([1]), "image/png");
    const failed = { ok: false, failure: ComposioFailure.UpstreamFailure };
    expect(await client.createSignIn()).toEqual(failed);
    expect(await client.readSignIn("abc")).toEqual(failed);
    expect(await client.readOrganization(composio.state.key)).toEqual(failed);
    expect(await client.resolveConsumer(composio.state.key, "ok_1")).toEqual(
      failed,
    );
    expect(await client.listAccounts(credentials, ["gmail"])).toEqual(failed);
    expect(await client.openSession(credentials, { github: "ca_0" })).toEqual(
      failed,
    );
    expect(
      await client.proxyExecute(credentials, "trs_Fake0001", {
        toolkit: "github",
        method: "GET",
        url: "https://api.github.com/user",
        headers: [],
      }),
    ).toEqual(failed);
    expect(await client.download(link)).toEqual(failed);
  });

  it("logs neither the key nor a sign-in id, whatever fails", async () => {
    const created = await client.createSignIn();
    if (!created.ok) throw new Error("no sign-in");
    const { id } = created.value;
    composio.approve(id);
    await client.readSignIn(id);
    await client.readSignIn(id);
    composio.expire(id);
    await client.readSignIn(id);
    await client.readOrganization(composio.state.key);
    await client.resolveConsumer(composio.state.key, "ok_Other");
    composio.state.intercept = () => {
      throw new Error(`failed with ${composio.state.key} for ${id}`);
    };
    await client.readSignIn(id);
    await client.listAccounts(credentials, ["gmail"]);
    await client.openSession(credentials, { github: "ca_0" });
    await client.proxyExecute(credentials, "trs_Fake0001", {
      toolkit: "github",
      method: "GET",
      url: "https://api.github.com/user",
      headers: [],
    });
    // A wrong key, refused by Composio and logged as a refusal.
    composio.state.intercept = null;
    await client.listAccounts({ ...credentials, key: "uak_wrongKey999" }, [
      "gmail",
    ]);

    const lines = logLines();
    expect(lines).toContain("composio.unreachable");
    expect(lines).toContain("composio.refused");
    expect(lines).not.toContain(composio.state.key);
    expect(lines).not.toContain(id);
    expect(lines).not.toContain("uak_");
  });
});
