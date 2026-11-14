/**
 * The last step of an app's call when the person's connection was made
 * through Composio (docs/design/2026-11-composio.md), through the proxy
 * with in-memory ports: what is refused before Composio is asked (no
 * service owns the URL, a method Composio doesn't send, a body that isn't
 * JSON or is past the cap), the request as the port is handed it, whose
 * connection a call for a named member uses, a connection reported as
 * expired once, and the provider's answer rebuilt header by header. The
 * port over D1 and Composio's API is in composio/calls.sqlite.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionVia,
  OAUTH_PRESETS,
  USER_HEADER,
  providerRegistry,
} from "@every-app/sdk/internal";
import type {
  ComposioCallAnswer,
  ComposioCallPort,
  ComposioSent,
} from "@/server/composio/calls";
import { ComposioBodyKind, ComposioFailure } from "@/server/composio/client";
import {
  handleIntegrationProxyRequest,
  type OAuthProxyDeps,
} from "@/server/integration-proxy";
import type { HeldConnection } from "@/server/oauth/heldTokens";

const ORIGIN = "http://every-app-gateway.internal";
const REGISTRY = providerRegistry(
  ["google-workspace"].map((id) => ({ id, spec: OAUTH_PRESETS[id]! })),
);
const GMAIL = "/api/integrations/google-workspace/gmail.googleapis.com";
const CONNECT_PATH = "/connect/google-workspace?app=mail";
const JSON_ONLY = "Through Composio only a JSON body can be sent.";

type Sent = Parameters<ComposioCallPort["send"]>[0];

/** A person's Google connection through Composio: Gmail, with one account. */
function connectionOf(userId: string): HeldConnection {
  return {
    id: `connection-${userId}`,
    userId,
    label: "alex@gmail.test",
    via: ConnectionVia.Composio,
    scopes: [],
    accounts: [{ service: "gmail", id: `ca_${userId}` }],
    status: "active",
    expiresAt: null,
  };
}

describe("a call sent through Composio", () => {
  /** Each person's connection, by user id. */
  let held: Map<string, HeldConnection>;
  /** What the port was asked to send. */
  let sent: Sent[];
  let answer: (input: Sent) => ComposioSent;
  /** The connections reported as just expired, and as used. */
  let expired: string[];
  let used: string[];
  let reported: { capability: string; status: number }[];

  beforeEach(() => {
    held = new Map([
      ["user-1", connectionOf("user-1")],
      ["user-2", connectionOf("user-2")],
    ]);
    sent = [];
    answer = () => answered({ messages: [] });
    expired = [];
    used = [];
    reported = [];
    for (const level of ["log", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation(() => undefined);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function answered(
    value: unknown,
    headers: Record<string, string> = {
      "content-type": "application/json; charset=UTF-8",
    },
    status = 200,
  ): ComposioSent {
    return {
      ok: true,
      value: {
        status,
        headers,
        body: { kind: ComposioBodyKind.Json, value },
      },
    };
  }

  const composio: ComposioCallPort = {
    on: async () => true,
    async send(input) {
      sent.push(input);
      return answer(input);
    },
  };

  async function call(
    path: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      /** The person behind the call; null for background work. */
      user?: string | null;
      composio?: ComposioCallPort | null;
    } = {},
  ): Promise<Response> {
    const userId = options.user === undefined ? "user-1" : options.user;
    const user =
      userId === null
        ? null
        : { id: userId, email: `${userId}@acme.test`, orgId: "org-1" };
    const port = options.composio === undefined ? composio : options.composio;
    const oauth: OAuthProxyDeps = {
      // No client: the provider is served through Composio.
      resolveClient: async () => null,
      connections: {
        find: async ({ userId: who }) => held.get(who) ?? null,
        allowedScopes: async () => ["gmail.readonly"],
        accessToken: async () => {
          throw new Error("no token is held for a call through Composio");
        },
        expired: async ({ connection }) => {
          expired.push(connection.id);
        },
        used: async ({ connection }) => {
          used.push(connection.id);
        },
      },
      ...(port ? { composio: port } : {}),
      app: {
        rowId: "row-mail",
        appId: "mail",
        scope: "org",
        organizationId: "org-1",
      },
      members: {
        mayUse: async () => true,
        revoke: async () => undefined,
      },
      identify: async () => ({ organizationId: "org-1", user: user as never }),
    };
    return handleIntegrationProxyRequest({
      request: new Request(`${ORIGIN}${path}`, {
        method: options.method ?? "GET",
        headers: options.headers ?? {},
        ...(options.body === undefined ? {} : { body: options.body }),
      }),
      capabilities: {
        "google-workspace": {
          scopes: ["gmail.readonly"],
          why: "Reads the person's mail.",
        },
      },
      lookup: REGISTRY,
      env: { GATEWAY_DEPLOYMENT_MODE: "self_hosted" },
      admit: async () => ({
        caller: {
          organizationId: "org-1",
          appId: "mail",
          worker: "every-app-mail",
          orgSource: "props",
        },
        user: user as never,
      }),
      fetchUpstream: async () => {
        throw new Error("nothing goes to the provider directly");
      },
      listMembers: async () => {
        throw new Error("not a service");
      },
      onCall: (report) => reported.push(report),
      oauth,
    });
  }

  async function refusalOf(response: Response) {
    return {
      status: response.status,
      header: response.headers.get("x-everyapp-error"),
      ...((await response.json()) as Record<string, unknown>),
    };
  }

  describe("is refused before Composio is asked", () => {
    afterEach(() => {
      expect(sent).toEqual([]);
      expect(reported).toEqual([]);
      expect(used).toEqual([]);
    });

    it("when no service of the provider's in Composio owns the URL", async () => {
      // One of Google's hosts, on a path that is no service's.
      const refused = await call(
        "/api/integrations/google-workspace/www.googleapis.com/oauth2/v3/userinfo",
      );
      expect(await refusalOf(refused)).toEqual({
        status: 400,
        header: "invalid_integration_route",
        error: "Bad Request",
        code: "invalid_integration_route",
        message:
          "Google is used through Composio here, and none of its services there owns this URL.",
      });
    });

    it("when the URL belongs to a service the app lists no scope for: the connection has no account for it, and connecting again would add none", async () => {
      // The app lists Gmail's scope alone; the URL is Calendar's.
      const refused = await call(
        "/api/integrations/google-workspace/www.googleapis.com/calendar/v3/calendars/primary/events",
      );
      expect(await refusalOf(refused)).toEqual({
        status: 400,
        header: "invalid_integration_route",
        error: "Bad Request",
        code: "invalid_integration_route",
        message:
          "Google is used through Composio here, and this app lists no scope for the service this URL belongs to. List one under capabilities.google-workspace.scopes in everyapp.config.ts and deploy again.",
      });
      expect(expired).toEqual([]);
    });

    it("for a method Composio doesn't send", async () => {
      for (const method of ["HEAD", "OPTIONS"]) {
        const refused = await call(`${GMAIL}/gmail/v1/users/me/profile`, {
          method,
        });
        expect(refused.status).toBe(400);
        expect(refused.headers.get("x-everyapp-error")).toBe(
          "invalid_integration_route",
        );
      }
      const refused = await call(`${GMAIL}/gmail/v1/users/me/messages/1`, {
        method: "OPTIONS",
      });
      expect(await refusalOf(refused)).toMatchObject({
        code: "invalid_integration_route",
        message:
          "Through Composio, Google calls are GET, POST, PUT, PATCH, DELETE.",
      });
    });

    it("for a body that isn't JSON, or says it is and isn't", async () => {
      const send = `${GMAIL}/gmail/v1/users/me/messages/send`;
      for (const [contentType, body] of [
        ["application/x-www-form-urlencoded", "raw=abc"],
        ["multipart/form-data; boundary=x", "--x--"],
        ["application/json", "{not json"],
      ]) {
        const refused = await call(send, {
          method: "POST",
          headers: { "content-type": contentType! },
          body: body!,
        });
        expect(await refusalOf(refused)).toEqual({
          status: 400,
          header: "integration_body_invalid",
          error: "Bad Request",
          code: "integration_body_invalid",
          message: JSON_ONLY,
        });
      }
    });

    it("for a body past 10 MiB", async () => {
      const refused = await call(`${GMAIL}/gmail/v1/users/me/drafts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ raw: "x".repeat(10 * 1024 * 1024) }),
      });
      expect(await refusalOf(refused)).toEqual({
        status: 413,
        header: "integration_body_invalid",
        error: "Payload Too Large",
        code: "integration_body_invalid",
        message: "Through Composio a body is at most 10 MiB.",
      });
    });

    it("as not set up when the Gateway has no way to Composio", async () => {
      const refused = await call(`${GMAIL}/gmail/v1/users/me/profile`, {
        composio: null,
      });
      expect(await refusalOf(refused)).toMatchObject({
        status: 503,
        code: "integration_not_configured",
      });
    });
  });

  describe("hands Composio the request", () => {
    it("with the service that owns the URL, the account the connection names for it, and the headers a direct call would forward", async () => {
      const response = await call(
        `${GMAIL}/gmail/v1/users/me/messages?q=from%3Aben&maxResults=5&access_token=mine&token=mine`,
        {
          headers: {
            accept: "application/json",
            "if-none-match": '"abc"',
            "x-goog-user-project": "p",
            authorization: "Bearer the-apps-own",
            cookie: "session=1",
            "x-api-key": "k",
            "x-everyapp-identity": "jwt",
            "accept-encoding": "gzip",
            "content-type": "application/json",
            "x-http-method-override": "DELETE",
            "x-forwarded-for": "10.0.0.1",
          },
        },
      );
      expect(response.status).toBe(200);
      expect(sent).toHaveLength(1);
      const { organizationId, connection, account, request } = sent[0]!;
      expect(organizationId).toBe("org-1");
      expect(connection).toMatchObject({
        id: "connection-user-1",
        userId: "user-1",
      });
      expect(account).toEqual({ service: "gmail", id: "ca_user-1" });
      expect(request.toolkit).toBe("gmail");
      expect(request.method).toBe("GET");
      expect(request.url).toBe(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=from%3Aben&maxResults=5",
      );
      expect(Object.fromEntries(request.headers)).toEqual({
        accept: "application/json",
        "if-none-match": '"abc"',
        "x-goog-user-project": "p",
      });
      expect("body" in request).toBe(false);
      expect(reported).toEqual([
        { capability: "google-workspace", status: 200 },
      ]);
      expect(used).toEqual(["connection-user-1"]);
    });

    it("a JSON body as a value, a JSON type by its suffix too, and no body when there is none", async () => {
      await call(`${GMAIL}/gmail/v1/users/me/drafts`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ message: { raw: "abc" }, ids: [1, 2] }),
      });
      await call(`${GMAIL}/gmail/v1/users/me/drafts/1`, {
        method: "PATCH",
        headers: { "content-type": "application/merge-patch+json" },
        body: "null",
      });
      await call(`${GMAIL}/gmail/v1/users/me/drafts/1`, { method: "DELETE" });
      expect(sent.map(({ request }) => [request.method, request.body])).toEqual(
        [
          ["POST", { message: { raw: "abc" }, ids: [1, 2] }],
          ["PATCH", null],
          ["DELETE", undefined],
        ],
      );
      expect("body" in sent[1]!.request).toBe(true);
      expect("body" in sent[2]!.request).toBe(false);
      // The app's content type is not passed on: Composio writes the body again.
      expect(Object.fromEntries(sent[0]!.request.headers)).toEqual({});
    });

    it("for the member background work names, with that member's connection and account", async () => {
      const response = await call(`${GMAIL}/gmail/v1/users/me/profile`, {
        user: null,
        headers: { [USER_HEADER]: "user-2" },
      });
      expect(response.status).toBe(200);
      expect(sent[0]).toMatchObject({
        connection: { id: "connection-user-2", userId: "user-2" },
        account: { service: "gmail", id: "ca_user-2" },
      });
    });
  });

  describe("tells the app to reconnect", () => {
    const failing = (failure: ComposioFailure, turnedExpired: boolean) => {
      answer = () => ({ ok: false, failure, expired: turnedExpired });
      return call(`${GMAIL}/gmail/v1/users/me/profile`).then(refusalOf);
    };

    it.each([
      [
        "the account is gone from the person's Composio",
        ComposioFailure.NotConnected,
        `The account this Google connection uses is gone from this person's Composio; connect it again at ${CONNECT_PATH}.`,
      ],
      [
        "Composio refused the person's key",
        ComposioFailure.KeyRefused,
        `Composio refused this person's key, so their Google connection can't be used; they link Composio again at ${CONNECT_PATH}.`,
      ],
    ])(
      "when %s, and says the connection expired only for the call that turned it",
      async (_why, failure, message) => {
        expect(await failing(failure, true)).toEqual({
          status: 409,
          header: "integration_not_connected",
          error: "Conflict",
          code: "integration_not_connected",
          message,
          connectPath: CONNECT_PATH,
          reconnect: true,
        });
        expect(expired).toEqual(["connection-user-1"]);
        // A call that found it expired already says nothing more.
        expect(await failing(failure, false)).toMatchObject({
          status: 409,
          reconnect: true,
        });
        expect(expired).toEqual(["connection-user-1"]);
        expect(reported).toEqual([]);
        expect(used).toEqual([]);
      },
    );
  });

  describe("answers with the provider's answer", () => {
    const answering = (value: ComposioCallAnswer) => {
      answer = () => ({ ok: true, value });
    };

    it("with the provider's status and headers, and none that no longer describe the body or carry a cookie", async () => {
      answering({
        status: 404,
        headers: {
          "content-type": "application/json; charset=UTF-8",
          etag: '"v1"',
          "x-ratelimit-remaining": "41",
          "content-encoding": "gzip",
          "content-length": "999",
          "transfer-encoding": "chunked",
          "set-cookie": "sid=1",
          connection: "keep-alive",
          "keep-alive": "timeout=5",
          // A name no header can hold: left out.
          "bad name": "x",
        },
        body: {
          kind: ComposioBodyKind.Json,
          value: { error: { code: 404, message: "Not Found" } },
        },
      });
      const response = await call(`${GMAIL}/gmail/v1/users/me/messages/x`);
      expect(response.status).toBe(404);
      // The provider's own refusal, not the Gateway's.
      expect(response.headers.get("x-everyapp-error")).toBeNull();
      expect(Object.fromEntries(response.headers)).toEqual({
        "content-type": "application/json; charset=UTF-8",
        etag: '"v1"',
        "x-ratelimit-remaining": "41",
      });
      expect(await response.text()).toBe(
        '{"error":{"code":404,"message":"Not Found"}}',
      );
      expect(reported).toEqual([
        { capability: "google-workspace", status: 404 },
      ]);
    });

    it("a JSON body with no content type gets one", async () => {
      answering({
        status: 200,
        headers: {},
        body: { kind: ComposioBodyKind.Json, value: [1, "two"] },
      });
      const json = await call(`${GMAIL}/gmail/v1/users/me/labels`);
      expect(json.headers.get("content-type")).toBe("application/json");
      expect(await json.text()).toBe('[1,"two"]');
    });

    it("a 304 and a 204 with no body, whatever Composio put in one", async () => {
      answering({
        status: 304,
        headers: { etag: '"v1"', "content-type": "application/json" },
        body: { kind: ComposioBodyKind.Json, value: {} },
      });
      const unchanged = await call(`${GMAIL}/gmail/v1/users/me/labels`, {
        headers: { "if-none-match": '"v1"' },
      });
      expect(unchanged.status).toBe(304);
      expect(unchanged.body).toBeNull();
      expect(unchanged.headers.get("etag")).toBe('"v1"');

      let cancelled = false;
      answering({
        status: 204,
        headers: {},
        body: {
          kind: ComposioBodyKind.Binary,
          contentType: "application/octet-stream",
          stream: new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }),
        },
      });
      const empty = await call(`${GMAIL}/gmail/v1/users/me/drafts/1`, {
        method: "DELETE",
      });
      expect(empty.status).toBe(204);
      expect(empty.body).toBeNull();
      expect(cancelled).toBe(true);
    });
  });
});
