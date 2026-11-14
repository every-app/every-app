/**
 * A test double for Composio's regular HTTP API
 * (docs/design/2026-11-composio.md), usable wherever the Gateway takes a
 * `fetch` for it: the sign-in that hands out a user key, the
 * organization and consumer project behind a key, the connected accounts,
 * tool-router sessions opened for named accounts, `proxy_execute`, and the
 * storage host a binary answer is left on. The answers have the shapes
 * measured on the real service, each error included, with one exception:
 * a session's `connected_accounts` follows Composio's API reference and
 * was not measured (a session is refused for an account that is gone, and
 * a call through one whose account went since is refused as not
 * connected, never sent with another account). Nothing leaves the
 * process: a request to any other URL throws. `state` records every
 * request for assertions.
 */

const API = "https://backend.composio.dev/api/v3.1";
const STORAGE_HOST = "temp.fake.r2.cloudflarestorage.com";

interface FakeComposioRequest {
  method: string;
  url: string;
  /** The path under the API base, query included. */
  path: string;
  headers: Record<string, string>;
  /** The parsed JSON body; undefined when there was none. */
  body: unknown;
  redirect: RequestRedirect;
}

interface FakeAccount {
  /** The toolkit's slug (`gmail`). */
  slug: string;
  /** Composio's id for the account; `ca_<its place in the list>` when left out. */
  id?: string;
  wordId: string;
  alias?: string | null;
  /** `data.displayName`; left out of `data` when undefined. */
  displayName?: unknown;
  status?: string;
  disabled?: boolean;
}

/** What the fake provider behind `proxy_execute` answers. */
interface FakeProviderAnswer {
  status: number;
  headers?: Record<string, unknown>;
  data?: unknown;
  /** A binary answer: Composio leaves the bytes on its storage host. */
  binary?: { url: string; contentType: string; size: number };
}

interface FakeProxyCall {
  sessionId: string;
  /** Composio's id for the account the call was sent with. */
  accountId: string;
  toolkit: string;
  endpoint: string;
  method: string;
  parameters: { name: string; value: string; type: string }[];
  body: unknown;
}

interface FakeSignIn {
  status: "pending" | "approved" | "used";
}

function refusal(status: number, slug: string, code: number): Response {
  return Response.json(
    {
      error: {
        message: `A message nothing may rely on (${slug}).`,
        code,
        slug,
        status,
        request_id: "req_fake",
        suggested_fix: "",
      },
    },
    { status },
  );
}

export function fakeComposio() {
  const state = {
    requests: [] as FakeComposioRequest[],
    proxyCalls: [] as FakeProxyCall[],
    key: "uak_fakeKey123",
    account: {
      id: "5b2f1c1e-0000-4000-8000-000000000001",
      email: "alex@example.com" as string | undefined,
      name: "Alex" as string | undefined,
    },
    orgId: "ok_AbC123",
    projectId: "pr_XyZ789",
    userId: "consumer-5b2f1c1e-0000-4000-8000-000000000002-ok_AbC123",
    signIns: new Map<string, FakeSignIn>(),
    accounts: [] as FakeAccount[],
    /** How many accounts a page of the account list holds. */
    pageSize: 100,
    /** Each open session, with the account it was opened for by toolkit. */
    sessions: new Map<string, Record<string, string>>(),
    /** The hosts each toolkit may be sent to; a toolkit not named takes any. */
    domains: {} as Record<string, string[]>,
    /** The provider behind `proxy_execute`. */
    provider: (_call: FakeProxyCall): FakeProviderAnswer => ({
      status: 200,
      headers: { "content-type": "application/json" },
      data: { ok: true },
    }),
    /** The bytes on the storage host, by URL. */
    files: new Map<string, { bytes: Uint8Array; contentType: string }>(),
    /** Answers a request before the fake does, when it returns a response. */
    intercept: null as
      | ((request: FakeComposioRequest) => Response | undefined)
      | null,
  };
  let sequence = 0;

  function keyRefused(request: FakeComposioRequest): Response | null {
    return request.headers["x-user-api-key"] === state.key
      ? null
      : refusal(401, "UserApiKey_Unauthorized", 1801);
  }

  function projectRefused(request: FakeComposioRequest): Response | null {
    return (
      keyRefused(request) ??
      (request.headers["x-org-id"] === state.orgId &&
      request.headers["x-project-id"] === state.projectId
        ? null
        : refusal(401, "Auth_Unauthorized", 1802))
    );
  }

  function idOf(account: FakeAccount): string {
    return account.id ?? `ca_${state.accounts.indexOf(account)}`;
  }

  /** The account `id` names for the toolkit, while it is connected and usable. */
  function usable(slug: string, id: string): FakeAccount | undefined {
    return state.accounts.find(
      (account) =>
        account.slug === slug &&
        idOf(account) === id &&
        (account.status ?? "ACTIVE") === "ACTIVE" &&
        !account.disabled,
    );
  }

  function accountJson(account: FakeAccount) {
    return {
      id: idOf(account),
      word_id: account.wordId,
      alias: account.alias ?? null,
      toolkit: { slug: account.slug },
      status: account.status ?? "ACTIVE",
      is_disabled: account.disabled ?? false,
      user_id: state.userId,
      authScheme: "OAUTH2",
      auth_config: { id: "ac_secret_config", is_composio_managed: true },
      data: {
        status: "ACTIVE",
        ...(account.displayName === undefined
          ? {}
          : { displayName: account.displayName }),
        scope: "secret.scope",
        access_token: "secret-access-token-placeholder",
      },
      state: { authScheme: "OAUTH2", val: { refresh_token: "secret-state" } },
      created_at: "2026-11-01T00:00:00.000Z",
      updated_at: "2026-11-01T00:00:00.000Z",
    };
  }

  function listAccounts(url: URL): Response {
    const slugs = (url.searchParams.get("toolkit_slugs") ?? "").split(",");
    const statuses = (url.searchParams.get("statuses") ?? "").split(",");
    const matching = state.accounts
      .map((account) => accountJson(account))
      .filter(
        (account) =>
          url.searchParams.get("user_ids") === state.userId &&
          slugs.includes(account.toolkit.slug) &&
          statuses.includes(account.status),
      );
    const page = Number(url.searchParams.get("cursor") ?? "1");
    const start = (page - 1) * state.pageSize;
    const pages = Math.max(1, Math.ceil(matching.length / state.pageSize));
    return Response.json({
      items: matching.slice(start, start + state.pageSize),
      next_cursor: page < pages ? String(page + 1) : null,
      total_pages: pages,
      current_page: page,
      total_items: matching.length,
    });
  }

  function proxyExecute(
    sessionId: string,
    request: FakeComposioRequest,
  ): Response {
    const pinned = state.sessions.get(sessionId);
    if (!pinned) {
      return refusal(404, "ToolRouterV2_SessionNotFound", 4301);
    }
    const body = request.body as {
      toolkit_slug: string;
      endpoint: string;
      method: string;
      parameters?: FakeProxyCall["parameters"];
      body?: unknown;
    };
    // The session sends with the account it was opened for, and with no
    // other: one that went since is not replaced.
    const pin = pinned[body.toolkit_slug];
    const account =
      pin === undefined ? undefined : usable(body.toolkit_slug, pin);
    if (!account) {
      return refusal(400, "ToolRouterV2_NoActiveConnection", 4302);
    }
    const hosts = state.domains[body.toolkit_slug];
    if (hosts && !hosts.includes(new URL(body.endpoint).host)) {
      return refusal(400, "ExternalProxy_OriginMismatch", 4303);
    }
    const call: FakeProxyCall = {
      sessionId,
      accountId: idOf(account),
      toolkit: body.toolkit_slug,
      endpoint: body.endpoint,
      method: body.method,
      parameters: body.parameters ?? [],
      body: body.body,
    };
    state.proxyCalls.push(call);
    const answer = state.provider(call);
    return Response.json({
      result_type: "completed",
      status: answer.status,
      headers: answer.headers ?? {},
      data: answer.binary ? {} : answer.data,
      ...(answer.binary
        ? {
            binary_data: {
              url: answer.binary.url,
              content_type: answer.binary.contentType,
              size: answer.binary.size,
              expires_at: "2026-11-10T12:00:00.000Z",
            },
          }
        : {}),
    });
  }

  function api(request: FakeComposioRequest, url: URL): Response {
    const route = `${request.method} ${url.pathname.slice(new URL(API).pathname.length)}`;
    if (route === "POST /cli/create-session") {
      const id = crypto.randomUUID();
      state.signIns.set(id, { status: "pending" });
      return Response.json(
        {
          id,
          code: "AB12CD",
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          status: "pending",
          scope: "user",
        },
        { status: 201 },
      );
    }
    if (route === "GET /cli/get-session") {
      const id = url.searchParams.get("id") ?? "";
      const signIn = state.signIns.get(id);
      const base = {
        id,
        code: "AB12CD",
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        scope: "user",
      };
      if (!signIn) return refusal(404, "CLI_SessionNotFound", 2103);
      // The real answer's slug was not recorded: the client goes by the 409.
      if (signIn.status === "used") {
        return refusal(409, "CLI_Unrecorded", 2104);
      }
      if (signIn.status === "pending") {
        return Response.json({ ...base, status: "pending" });
      }
      signIn.status = "used";
      return Response.json({
        ...base,
        status: "linked",
        account: state.account,
        api_key: state.key,
      });
    }
    if (route === "GET /auth/session/info") {
      return (
        keyRefused(request) ??
        Response.json({
          project: {
            id: "another-project",
            name: "Not the project used",
            org: { id: state.orgId, name: "Alex's org", plan: "free" },
          },
          org_member: {
            id: state.account.id,
            email: state.account.email,
            name: state.account.name,
            role: "ADMIN",
          },
          api_key: null,
        })
      );
    }
    if (route === "POST /org/consumer/project/resolve") {
      return (
        keyRefused(request) ??
        (request.headers["x-org-id"] === state.orgId
          ? Response.json({
              project_id: "5b2f1c1e-0000-4000-8000-000000000003",
              project_nano_id: state.projectId,
              project_name: "Consumer",
              org_id: state.orgId,
              project_type: "CONSUMER",
              config: { secret: "config" },
              consumer_user_id: state.userId,
              user_id: state.account.id,
            })
          : refusal(401, "Auth_Unauthorized", 1802))
      );
    }
    if (route === "GET /connected_accounts") {
      return projectRefused(request) ?? listAccounts(url);
    }
    if (route === "POST /tool_router/session") {
      const refused = projectRefused(request);
      if (refused) return refused;
      const opened = request.body as {
        user_id: string;
        connected_accounts?: Record<string, string[]>;
      };
      const pinned: Record<string, string> = {};
      for (const [slug, ids] of Object.entries(
        opened.connected_accounts ?? {},
      )) {
        const id = ids[0];
        // The real refusal's slug was not recorded: the client goes by
        // the status.
        if (ids.length !== 1 || id === undefined || !usable(slug, id)) {
          return refusal(400, "ToolRouterV2_Unrecorded", 4304);
        }
        pinned[slug] = id;
      }
      sequence += 1;
      const sessionId = `trs_Fake${String(sequence).padStart(4, "0")}`;
      state.sessions.set(sessionId, pinned);
      return Response.json(
        {
          session_id: sessionId,
          config: { user_id: opened.user_id },
          mcp: { url: "https://mcp.invalid/" },
          tool_router_tools: [],
        },
        { status: 201 },
      );
    }
    const proxied =
      /^POST \/tool_router\/session\/([^/]+)\/proxy_execute$/.exec(route);
    if (proxied) {
      return projectRefused(request) ?? proxyExecute(proxied[1]!, request);
    }
    return refusal(404, "Route_NotFound", 1000);
  }

  async function fetch(sent: Request): Promise<Response> {
    if (sent.signal.aborted) throw sent.signal.reason;
    const url = new URL(sent.url);
    const text = await sent.text();
    const request: FakeComposioRequest = {
      method: sent.method,
      url: sent.url,
      path: sent.url.startsWith(API) ? sent.url.slice(API.length) : sent.url,
      headers: Object.fromEntries(sent.headers),
      body: text === "" ? undefined : JSON.parse(text),
      redirect: sent.redirect,
    };
    state.requests.push(request);
    const intercepted = state.intercept?.(request);
    if (intercepted) return intercepted;
    if (sent.url.startsWith(`${API}/`)) return api(request, url);
    if (url.host === STORAGE_HOST) {
      const file = state.files.get(sent.url);
      if (!file) return new Response("no such object", { status: 404 });
      return new Response(file.bytes.slice().buffer, {
        headers: { "content-type": file.contentType },
      });
    }
    throw new Error(`fake Composio: no such host (${url.host})`);
  }

  return {
    fetch,
    state,
    /** The person approves the sign-in in Composio's dashboard. */
    approve(id: string): void {
      const signIn = state.signIns.get(id);
      if (!signIn) throw new Error("fake Composio: no such sign-in");
      signIn.status = "approved";
    },
    /** The sign-in is unknown to Composio from now on. */
    expire(id: string): void {
      state.signIns.delete(id);
    },
    /** Leave `bytes` on the storage host; the link a binary answer carries. */
    store(name: string, bytes: Uint8Array, contentType: string) {
      const url = `https://${STORAGE_HOST}/${name}?X-Amz-Signature=fake`;
      state.files.set(url, { bytes, contentType });
      return { url, contentType, size: bytes.byteLength };
    },
    /** A Composio refusal in its own shape, for `intercept`. */
    refusal,
  };
}

export type FakeComposio = ReturnType<typeof fakeComposio>;
