/**
 * Composio's regular HTTP API, as far as the Gateway uses it
 * (docs/design/2026-11-composio.md): the sign-in that hands out a
 * person's user key, their organization and consumer project, their
 * connected accounts, and one provider request sent through a session
 * opened for named accounts.
 * Plain HTTP and JSON over the `fetch` it is given, so tests pass a fake
 * (src/test/fake-composio.ts).
 *
 * Nothing here throws. A call answers its value or one of
 * {@link ComposioFailure}, decided by the HTTP status and Composio's
 * `error.slug`, never by its message. The key and the sign-in id go into
 * a request and nowhere else: no log line and no error carries them.
 * Answers are parsed with zod, and only the fields named here are kept.
 */
import { logEvent } from "@every-app/perimeter";
import { COMPOSIO_DASHBOARD_URL } from "@every-app/sdk/internal";
import { z } from "zod";
import type { Fetch } from "@/server/oauth/tokens";

const API = "https://backend.composio.dev/api/v3.1";
const TIMEOUT_MS = 30_000;
const ACCOUNT_PAGES = 5;
/** The largest answer read from Composio: a call's JSON, which the Worker holds whole, or a binary answer fetched from its storage. */
const BINARY_BYTES = 25 * 1024 * 1024;
const STORAGE_HOST_SUFFIX = ".r2.cloudflarestorage.com";

/** An id of Composio's, as it may enter a URL or a header. */
const ID = /^[A-Za-z0-9_-]+$/;
const SESSION_ID = /^trs_[A-Za-z0-9_-]+$/;

/** How a call to Composio fails. */
export enum ComposioFailure {
  /** The key is wrong or revoked (any 401). */
  KeyRefused = "key_refused",
  /** The account the call names is gone from the person's Composio. */
  NotConnected = "not_connected",
  /** The URL's host is outside the service's own. */
  HostRefused = "host_refused",
  /** The session is gone: open another. */
  SessionGone = "session_gone",
  /** Anything else: no answer, a timeout, an answer in another shape. */
  UpstreamFailure = "upstream_failure",
}

type ComposioResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: ComposioFailure };

/** Where a sign-in stands. */
export enum SignInState {
  /** The person hasn't approved yet. */
  Pending = "pending",
  /** Approved, and this lookup carries the key: the only one that does. */
  Linked = "linked",
  /** The key was already picked up. */
  Used = "used",
  /** Unknown to Composio, or expired. */
  Gone = "gone",
}

type SignIn =
  | { state: SignInState.Pending }
  | { state: SignInState.Linked; key: string; account: string }
  | { state: SignInState.Used }
  | { state: SignInState.Gone };

/** What every call after linking is made with. */
export interface ComposioCredentials {
  key: string;
  orgId: string;
  projectId: string;
  userId: string;
}

/** An account connected in a person's Composio, with the service it is of. */
export interface ConnectedAccount {
  /** Composio's name for the service (`gmail`). */
  slug: string;
  /** Composio's id for the connected account: another account has another. */
  id: string;
  /** How the account is named. */
  account: string;
}

export const COMPOSIO_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
] as const;
export type ComposioMethod = (typeof COMPOSIO_METHODS)[number];

/** One provider request, as Composio sends it for the person. */
export interface ComposioProxyRequest {
  toolkit: string;
  method: ComposioMethod;
  /** The provider's full URL, query included. */
  url: string;
  headers: readonly (readonly [name: string, value: string])[];
  /** A JSON value; left out when the request has no body. */
  body?: unknown;
}

export enum ComposioBodyKind {
  Json = "json",
  Text = "text",
  Binary = "binary",
}

/** Where Composio left a binary answer. */
interface ComposioBinaryLink {
  url: string;
  contentType: string;
  size: number;
}

type ComposioBody =
  | { kind: ComposioBodyKind.Json; value: unknown }
  | { kind: ComposioBodyKind.Text; text: string }
  | ({ kind: ComposioBodyKind.Binary } & ComposioBinaryLink);

/** The provider's answer, as Composio passes it on. */
interface ComposioProxyAnswer {
  status: number;
  /** The provider's headers, lower-case names. */
  headers: Record<string, string>;
  body: ComposioBody;
}

export interface ComposioClient {
  createSignIn(): Promise<ComposioResult<{ id: string; expiresAt: number }>>;
  readSignIn(id: string): Promise<ComposioResult<SignIn>>;
  readOrganization(key: string): Promise<ComposioResult<string>>;
  resolveConsumer(
    key: string,
    orgId: string,
  ): Promise<ComposioResult<{ projectId: string; userId: string }>>;
  /** Every usable account of the services `slugs`, in Composio's order. */
  listAccounts(
    credentials: ComposioCredentials,
    slugs: readonly string[],
  ): Promise<ComposioResult<ConnectedAccount[]>>;
  /**
   * A session that sends through `accounts` only: for each service, the
   * one account a call to it uses. Composio refuses to open one for an
   * account that is gone.
   */
  openSession(
    credentials: ComposioCredentials,
    accounts: Readonly<Record<string, string>>,
  ): Promise<ComposioResult<string>>;
  proxyExecute(
    credentials: ComposioCredentials,
    sessionId: string,
    request: ComposioProxyRequest,
  ): Promise<ComposioResult<ComposioProxyAnswer>>;
  /** The bytes of a binary answer, from Composio's storage and nowhere else. */
  download(
    link: ComposioBinaryLink,
  ): Promise<ComposioResult<ReadableStream<Uint8Array> | null>>;
}

/** The page where a person approves the sign-in `id`. */
export function composioSignInUrl(id: string): string {
  return `${COMPOSIO_DASHBOARD_URL}/?cliKey=${encodeURIComponent(id)}`;
}

const idShape = z.string().regex(ID);

const errorSchema = z.object({ error: z.object({ slug: z.string() }) });

const createdSignInSchema = z.object({
  id: idShape,
  expiresAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
});

const signInSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({
    status: z.literal("linked"),
    api_key: z.string().min(1),
    account: z.object({
      email: z.string().nullish(),
      name: z.string().nullish(),
    }),
  }),
]);

const sessionInfoSchema = z.object({
  project: z.object({ org: z.object({ id: idShape }) }),
});

const consumerSchema = z.object({
  project_nano_id: idShape,
  consumer_user_id: idShape,
});

const accountsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().min(1),
      word_id: z.string().min(1),
      alias: z.string().nullish(),
      toolkit: z.object({ slug: z.string() }),
      status: z.string(),
      is_disabled: z.boolean(),
      // Of `data`, the account's name and nothing else.
      data: z.object({ displayName: z.unknown() }).partial().nullish(),
    }),
  ),
  next_cursor: z.string().nullish(),
});

const sessionSchema = z.object({ session_id: z.string().regex(SESSION_ID) });

const proxySchema = z.object({
  status: z.number().int().min(200).max(599),
  headers: z.record(z.string(), z.unknown()).nullish(),
  data: z.unknown(),
  binary_data: z
    .object({
      url: z.string().min(1),
      content_type: z.string().min(1),
      size: z.number().int().min(0),
    })
    .nullish(),
});

const failed = (failure: ComposioFailure) => ({ ok: false as const, failure });
const answered = <T>(value: T) => ({ ok: true as const, value });

function slugOf(body: unknown): string | undefined {
  return errorSchema.safeParse(body).data?.error.slug;
}

/** What a status that isn't 2xx means. */
function failureOf(status: number, body: unknown): ComposioFailure {
  if (status === 401) return ComposioFailure.KeyRefused;
  switch (slugOf(body)) {
    case "ToolRouterV2_NoActiveConnection":
      return ComposioFailure.NotConnected;
    case "ExternalProxy_OriginMismatch":
      return ComposioFailure.HostRefused;
    case "ToolRouterV2_SessionNotFound":
      return ComposioFailure.SessionGone;
    default:
      return ComposioFailure.UpstreamFailure;
  }
}

function keyHeaders(key: string): Record<string, string> {
  return { "x-user-api-key": key };
}

/** The headers of a call made in the person's consumer project, or null when an id has a shape that can't go in one. */
function projectHeaders(
  credentials: ComposioCredentials,
): Record<string, string> | null {
  const { key, orgId, projectId, userId } = credentials;
  if (![orgId, projectId, userId].every((each) => ID.test(each))) return null;
  return {
    ...keyHeaders(key),
    "x-org-id": orgId,
    "x-project-id": projectId,
  };
}

/** The account's name: its alias, else the name its service gives it, else Composio's own word for it. */
function accountLabel(account: {
  word_id: string;
  alias?: string | null;
  data?: { displayName?: unknown } | null;
}): string {
  if (account.alias) return account.alias;
  const displayName = account.data?.displayName;
  if (typeof displayName === "string" && displayName !== "") return displayName;
  return account.word_id;
}

/** The provider's headers Composio gave as text. */
function textHeaders(
  headers: Record<string, unknown> | null | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/**
 * An answer's body as text, or null once it passes {@link BINARY_BYTES}:
 * a provider's answer comes back inside Composio's JSON, which is held
 * whole before it is parsed, so a length past the cap is refused unread
 * and the bytes are counted as they arrive.
 */
async function cappedText(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > BINARY_BYTES) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > BINARY_BYTES) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** Passes bytes through until they pass {@link BINARY_BYTES}, then fails the stream. */
function capped(): TransformStream<Uint8Array, Uint8Array> {
  let total = 0;
  return new TransformStream({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > BINARY_BYTES) {
        logEvent("composio.binary_refused", { size: total }, "warn");
        controller.error(new Error("The answer is larger than the cap"));
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

export function composioClient(fetchUpstream: Fetch): ComposioClient {
  /** One request: the status and the parsed JSON body, or null when there was no answer. */
  async function send(sent: {
    /** The call's name in a log line: never a URL, which may carry an id. */
    call: string;
    method: "GET" | "POST";
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
  }): Promise<{ status: number; body: unknown } | null> {
    let response: Response;
    try {
      response = await fetchUpstream(
        new Request(`${API}${sent.path}`, {
          method: sent.method,
          headers: {
            ...sent.headers,
            ...(sent.body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          ...(sent.body === undefined
            ? {}
            : { body: JSON.stringify(sent.body) }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        }),
      );
    } catch {
      // The error may quote a header: its text is never read.
      logEvent("composio.unreachable", { call: sent.call }, "warn");
      return null;
    }
    const text = await cappedText(response);
    if (text === null) {
      logEvent("composio.answer_too_large", { call: sent.call }, "warn");
      return null;
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      logEvent(
        "composio.refused",
        { call: sent.call, status: response.status, slug: slugOf(body) },
        "warn",
      );
    }
    return { status: response.status, body };
  }

  /** A call whose 2xx answer parses with `schema`. */
  async function ask<T>(
    sent: Parameters<typeof send>[0],
    schema: z.ZodType<T>,
  ): Promise<ComposioResult<T>> {
    const response = await send(sent);
    if (!response) return failed(ComposioFailure.UpstreamFailure);
    if (response.status < 200 || response.status > 299) {
      return failed(failureOf(response.status, response.body));
    }
    const parsed = schema.safeParse(response.body);
    if (!parsed.success) {
      logEvent("composio.unexpected_answer", { call: sent.call }, "warn");
      return failed(ComposioFailure.UpstreamFailure);
    }
    return answered(parsed.data);
  }

  return {
    async createSignIn() {
      const created = await ask(
        {
          call: "create_sign_in",
          method: "POST",
          path: "/cli/create-session",
          body: { scope: "user", source: "EveryApp" },
        },
        createdSignInSchema,
      );
      // No key was sent, so none was refused.
      if (!created.ok) return failed(ComposioFailure.UpstreamFailure);
      return answered({
        id: created.value.id,
        expiresAt: Date.parse(created.value.expiresAt),
      });
    },

    async readSignIn(signInId) {
      if (!ID.test(signInId)) return failed(ComposioFailure.UpstreamFailure);
      const response = await send({
        call: "read_sign_in",
        method: "GET",
        path: `/cli/get-session?id=${signInId}`,
      });
      if (!response) return failed(ComposioFailure.UpstreamFailure);
      if (response.status === 409) return answered({ state: SignInState.Used });
      if (
        response.status === 404 &&
        slugOf(response.body) === "CLI_SessionNotFound"
      ) {
        return answered({ state: SignInState.Gone });
      }
      const parsed =
        response.status === 200
          ? signInSchema.safeParse(response.body)
          : undefined;
      if (!parsed?.success) return failed(ComposioFailure.UpstreamFailure);
      if (parsed.data.status === "pending") {
        return answered({ state: SignInState.Pending });
      }
      const account = parsed.data.account.email || parsed.data.account.name;
      if (!account) return failed(ComposioFailure.UpstreamFailure);
      return answered({
        state: SignInState.Linked,
        key: parsed.data.api_key,
        account,
      });
    },

    async readOrganization(key) {
      const info = await ask(
        {
          call: "session_info",
          method: "GET",
          path: "/auth/session/info",
          headers: keyHeaders(key),
        },
        sessionInfoSchema,
      );
      return info.ok ? answered(info.value.project.org.id) : info;
    },

    async resolveConsumer(key, orgId) {
      if (!ID.test(orgId)) return failed(ComposioFailure.UpstreamFailure);
      const consumer = await ask(
        {
          call: "resolve_consumer",
          method: "POST",
          path: "/org/consumer/project/resolve",
          headers: { ...keyHeaders(key), "x-org-id": orgId },
        },
        consumerSchema,
      );
      if (!consumer.ok) return consumer;
      return answered({
        projectId: consumer.value.project_nano_id,
        userId: consumer.value.consumer_user_id,
      });
    },

    async listAccounts(credentials, slugs) {
      const headers = projectHeaders(credentials);
      if (!headers || !slugs.every((slug) => ID.test(slug))) {
        return failed(ComposioFailure.UpstreamFailure);
      }
      const found: ConnectedAccount[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < ACCOUNT_PAGES; page += 1) {
        const listed: ComposioResult<z.infer<typeof accountsSchema>> =
          await ask(
            {
              call: "connected_accounts",
              method: "GET",
              // The slugs joined by a bare comma, as Composio takes them.
              path:
                `/connected_accounts?user_ids=${credentials.userId}` +
                `&statuses=ACTIVE&toolkit_slugs=${slugs.join(",")}&limit=100` +
                (cursor === null
                  ? ""
                  : `&cursor=${encodeURIComponent(cursor)}`),
              headers,
            },
            accountsSchema,
          );
        if (!listed.ok) return listed;
        for (const account of listed.value.items) {
          const slug = account.toolkit.slug;
          if (
            account.status !== "ACTIVE" ||
            account.is_disabled ||
            !slugs.includes(slug) ||
            !ID.test(account.id) ||
            found.some((each) => each.id === account.id)
          ) {
            continue;
          }
          found.push({
            slug,
            id: account.id,
            account: accountLabel(account),
          });
        }
        cursor = listed.value.next_cursor ?? null;
        if (cursor === null) break;
      }
      return answered(found);
    },

    async openSession(credentials, accounts) {
      const headers = projectHeaders(credentials);
      const pinned = Object.entries(accounts);
      if (
        !headers ||
        pinned.length === 0 ||
        !pinned.every(([slug, id]) => ID.test(slug) && ID.test(id))
      ) {
        return failed(ComposioFailure.UpstreamFailure);
      }
      const session = await ask(
        {
          call: "open_session",
          method: "POST",
          path: "/tool_router/session",
          headers,
          body: {
            user_id: credentials.userId,
            // The session sends through these accounts and no others.
            connected_accounts: Object.fromEntries(
              pinned.map(([slug, id]) => [slug, [id]]),
            ),
          },
        },
        sessionSchema,
      );
      return session.ok ? answered(session.value.session_id) : session;
    },

    async proxyExecute(credentials, sessionId, request) {
      const headers = projectHeaders(credentials);
      if (!headers || !SESSION_ID.test(sessionId)) {
        return failed(ComposioFailure.UpstreamFailure);
      }
      const executed = await ask(
        {
          call: "proxy_execute",
          method: "POST",
          path: `/tool_router/session/${sessionId}/proxy_execute`,
          headers,
          body: {
            toolkit_slug: request.toolkit,
            endpoint: request.url,
            method: request.method,
            parameters: request.headers.map(([name, value]) => ({
              name,
              value,
              type: "header",
            })),
            ...(request.body === undefined ? {} : { body: request.body }),
          },
        },
        proxySchema,
      );
      if (!executed.ok) return executed;
      const { status, data, binary_data: binary } = executed.value;
      let body: ComposioBody;
      if (binary) {
        body = {
          kind: ComposioBodyKind.Binary,
          url: binary.url,
          contentType: binary.content_type,
          size: binary.size,
        };
      } else if (typeof data === "string") {
        body = { kind: ComposioBodyKind.Text, text: data };
      } else {
        body = { kind: ComposioBodyKind.Json, value: data };
      }
      return answered({
        status,
        headers: textHeaders(executed.value.headers),
        body,
      });
    },

    async download(link) {
      let url: URL;
      try {
        url = new URL(link.url);
      } catch {
        return failed(ComposioFailure.UpstreamFailure);
      }
      if (
        url.protocol !== "https:" ||
        !url.hostname.endsWith(STORAGE_HOST_SUFFIX) ||
        link.size > BINARY_BYTES
      ) {
        logEvent("composio.binary_refused", { size: link.size }, "warn");
        return failed(ComposioFailure.UpstreamFailure);
      }
      try {
        const response = await fetchUpstream(
          new Request(url, {
            redirect: "error",
            signal: AbortSignal.timeout(TIMEOUT_MS),
          }),
        );
        if (response.status !== 200) {
          logEvent(
            "composio.binary_failed",
            { status: response.status },
            "warn",
          );
          return failed(ComposioFailure.UpstreamFailure);
        }
        // The size Composio gave is its word for the object. The bytes
        // are counted as they pass, so no answer is longer than the cap
        // whatever the link said.
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > BINARY_BYTES) {
          await response.body?.cancel();
          logEvent("composio.binary_refused", { size: declared }, "warn");
          return failed(ComposioFailure.UpstreamFailure);
        }
        return answered(response.body?.pipeThrough(capped()) ?? null);
      } catch {
        logEvent("composio.binary_failed", {}, "warn");
        return failed(ComposioFailure.UpstreamFailure);
      }
    },
  };
}
