/**
 * The Cloudflare API calls the loop makes from the host, as small typed
 * `fetch`es with the test account's token (spec decision 1): never the `cf`
 * binary on the host, which can fall back to Ben's Keychain login. Token
 * verify, accounts and zones for preflight's gate; D1 list and query for the
 * D1-side claim and the link expiry; the workers.dev subdomain PUT for the
 * `register_workers_subdomain` hand-off; DNS records for the post-wipe
 * check; KV namespaces for the in-account run marker. A fake fetch answers
 * the same routes in tests. No error message ever carries the token.
 */
import { z } from "zod";

const CF_API = "https://api.cloudflare.com/client/v4";

const ApiError = z.looseObject({ code: z.number(), message: z.string() });
const Envelope = z.looseObject({
  success: z.boolean(),
  errors: z.array(ApiError).default([]),
  result: z.unknown(),
  result_info: z
    .looseObject({
      page: z.number().nullish(),
      total_pages: z.number().nullish(),
    })
    .nullish(),
});

const TokenVerify = z.looseObject({
  id: z.string(),
  status: z.string(),
});
const AccountRow = z.looseObject({
  id: z.string(),
  name: z.string().nullish(),
});
const ZoneRow = z.looseObject({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  name_servers: z.array(z.string()).nullish(),
});
/** The same shape packages/cli/src/lib/cf/plan.ts reads from `cf accounts subscriptions get`. */
export const SubscriptionRow = z.looseObject({
  state: z.string().nullish(),
  rate_plan: z
    .looseObject({
      id: z.string().nullish(),
      public_name: z.string().nullish(),
    })
    .nullish(),
  product: z.looseObject({ name: z.string().nullish() }).nullish(),
});
const D1Row = z.looseObject({ uuid: z.string(), name: z.string() });
const D1QueryResult = z.array(
  z.looseObject({
    results: z.array(z.record(z.string(), z.unknown())).default([]),
    success: z.boolean().nullish(),
    meta: z.looseObject({ changes: z.number().nullish() }).nullish(),
  }),
);
const WorkersSubdomain = z.looseObject({
  subdomain: z.string().nullish(),
});
export const DnsRecordRow = z.looseObject({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  content: z.string().nullish(),
});
const KvNamespaceRow = z.looseObject({
  id: z.string(),
  title: z.string(),
});

export type Zone = z.infer<typeof ZoneRow>;
export type DnsRecord = z.infer<typeof DnsRecordRow>;
export type D1Statement = z.infer<typeof D1QueryResult>[number];

export class CfApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly errors: Array<{ code: number; message: string }>,
  ) {
    super(
      `${method} ${path} answered ${status}${
        errors.length > 0
          ? `: ${errors.map((error) => `${error.code} ${error.message}`).join("; ")}`
          : ""
      }`,
    );
    this.name = "CfApiError";
  }
}

export interface CfApi {
  accountId: string;
  /** GET /user/tokens/verify: the token's own status ("active"). */
  verifyToken(): Promise<{ id: string; status: string }>;
  /** GET /accounts: every account the token sees. */
  listAccounts(): Promise<Array<{ id: string; name: string | null }>>;
  /** GET /zones?name=: the zone by name (every zone the token sees without a name). */
  listZones(name?: string): Promise<Zone[]>;
  /** GET /accounts/{id}/subscriptions, verbatim rows for the plan check and plan.test.ts. */
  subscriptions(): Promise<Array<z.infer<typeof SubscriptionRow>>>;
  /** GET /accounts/{id}/d1/database?name=. */
  d1List(name?: string): Promise<Array<{ uuid: string; name: string }>>;
  /** POST /accounts/{id}/d1/database/{db}/query. */
  d1Query(
    databaseId: string,
    sql: string,
    params?: unknown[],
  ): Promise<D1Statement[]>;
  /** GET /accounts/{id}/workers/subdomain; null when the account has none yet. */
  getWorkersSubdomain(): Promise<string | null>;
  /** PUT /accounts/{id}/workers/subdomain. */
  putWorkersSubdomain(subdomain: string): Promise<string | null>;
  /** GET /zones/{zone}/dns_records, every page. */
  dnsRecordsList(zoneId: string): Promise<DnsRecord[]>;
  /** GET /accounts/{id}/storage/kv/namespaces, every page. */
  kvNamespacesList(): Promise<Array<{ id: string; title: string }>>;
  /** POST /accounts/{id}/storage/kv/namespaces. */
  kvNamespaceCreate(title: string): Promise<{ id: string; title: string }>;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

interface CfApiOptions {
  token: string;
  accountId: string;
  fetch?: FetchLike;
  base?: string;
}

export function createCfApi(options: CfApiOptions): CfApi {
  const fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike);
  const base = options.base ?? CF_API;
  const account = `/accounts/${options.accountId}`;

  async function call<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${options.token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let envelope: z.infer<typeof Envelope>;
    try {
      envelope = Envelope.parse(await response.json());
    } catch {
      throw new CfApiError(method, path, response.status, [
        { code: 0, message: "not a Cloudflare API envelope" },
      ]);
    }
    if (!response.ok || !envelope.success) {
      throw new CfApiError(method, path, response.status, envelope.errors);
    }
    return schema.parse(envelope.result);
  }

  /** Every page of a list endpoint. */
  async function paged<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
    const joiner = path.includes("?") ? "&" : "?";
    const rows: T[] = [];
    for (let page = 1; page <= 50; page += 1) {
      const response = await fetchImpl(
        `${base}${path}${joiner}per_page=100&page=${page}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${options.token}` },
        },
      );
      let envelope: z.infer<typeof Envelope>;
      try {
        envelope = Envelope.parse(await response.json());
      } catch {
        throw new CfApiError("GET", path, response.status, [
          { code: 0, message: "not a Cloudflare API envelope" },
        ]);
      }
      if (!response.ok || !envelope.success)
        throw new CfApiError("GET", path, response.status, envelope.errors);
      rows.push(...z.array(schema).parse(envelope.result));
      if ((envelope.result_info?.total_pages ?? 1) <= page) break;
    }
    return rows;
  }

  return {
    accountId: options.accountId,
    verifyToken: () => call("GET", "/user/tokens/verify", TokenVerify),
    listAccounts: async () =>
      (await paged("/accounts", AccountRow)).map((row) => ({
        id: row.id,
        name: row.name ?? null,
      })),
    listZones: (name) =>
      paged(
        name ? `/zones?name=${encodeURIComponent(name)}` : "/zones",
        ZoneRow,
      ),
    subscriptions: () =>
      call("GET", `${account}/subscriptions`, z.array(SubscriptionRow)),
    d1List: (name) =>
      paged(
        name
          ? `${account}/d1/database?name=${encodeURIComponent(name)}`
          : `${account}/d1/database`,
        D1Row,
      ),
    d1Query: (databaseId, sql, params = []) =>
      call(
        "POST",
        `${account}/d1/database/${databaseId}/query`,
        D1QueryResult,
        { sql, params },
      ),
    getWorkersSubdomain: async () => {
      try {
        return (
          (await call("GET", `${account}/workers/subdomain`, WorkersSubdomain))
            .subdomain ?? null
        );
      } catch (error) {
        if (error instanceof CfApiError && error.status === 404) return null;
        throw error;
      }
    },
    putWorkersSubdomain: async (subdomain) =>
      (
        await call("PUT", `${account}/workers/subdomain`, WorkersSubdomain, {
          subdomain,
        })
      ).subdomain ?? null,
    dnsRecordsList: (zoneId) =>
      paged(`/zones/${zoneId}/dns_records`, DnsRecordRow),
    kvNamespacesList: () =>
      paged(`${account}/storage/kv/namespaces`, KvNamespaceRow),
    kvNamespaceCreate: (title) =>
      call("POST", `${account}/storage/kv/namespaces`, KvNamespaceRow, {
        title,
      }),
  };
}

// ---------------------------------------------------------------------------
// The token gate (design 5, tightened): applied before every token-bearing call.
// ---------------------------------------------------------------------------

/** Ben's main account: refused by constant, whatever any list says. */
export const FORBIDDEN_ACCOUNT_IDS: readonly string[] = [
  "23bc28f0b638fbfc1c7f838573c17ee3",
];

export type TokenGate =
  | { ok: true; accounts: string[] }
  | {
      ok: false;
      code:
        | "token_rejected"
        | "token_too_broad"
        | "account_not_visible"
        | "account_forbidden";
      detail: string;
    };

/**
 * The token is active, sees exactly the account asked for, and none that is
 * forbidden. A bogus token verifies as inactive or 400s: that is
 * `token_rejected`, the fixture error that runs nothing.
 */
export async function tokenGate(
  cf: CfApi,
  accountId: string,
): Promise<TokenGate> {
  if (FORBIDDEN_ACCOUNT_IDS.includes(accountId)) {
    return {
      ok: false,
      code: "account_forbidden",
      detail: `${accountId} is never a test account.`,
    };
  }
  let status: string;
  try {
    status = (await cf.verifyToken()).status;
  } catch (error) {
    if (error instanceof CfApiError && error.status < 500) {
      return {
        ok: false,
        code: "token_rejected",
        detail: `Cloudflare rejected the token (${error.status}).`,
      };
    }
    throw error;
  }
  if (status !== "active") {
    return {
      ok: false,
      code: "token_rejected",
      detail: `The token's status is "${status}", not active.`,
    };
  }
  const accounts = (await cf.listAccounts()).map((row) => row.id);
  const forbidden = accounts.filter((id) => FORBIDDEN_ACCOUNT_IDS.includes(id));
  if (forbidden.length > 0) {
    return {
      ok: false,
      code: "account_forbidden",
      detail: `The token sees a forbidden account.`,
    };
  }
  if (!accounts.includes(accountId)) {
    return {
      ok: false,
      code: "account_not_visible",
      detail: `The token does not see ${accountId}.`,
    };
  }
  if (accounts.length !== 1) {
    return {
      ok: false,
      code: "token_too_broad",
      detail: `The token sees ${accounts.length} accounts; it must see ${accountId} alone.`,
    };
  }
  return { ok: true, accounts };
}

// ---------------------------------------------------------------------------
// A fake fetch for tests.
// ---------------------------------------------------------------------------

export interface FakeCfCall {
  method: string;
  /** The path after the API base, query string included. */
  path: string;
  body: unknown;
}

export interface FakeCfReply {
  status?: number;
  success?: boolean;
  errors?: Array<{ code: number; message: string }>;
  result?: unknown;
  total_pages?: number;
}

export interface FakeCfRoute {
  method: string;
  path: RegExp;
  reply: (match: RegExpExecArray, call: FakeCfCall) => FakeCfReply;
}

/**
 * A fetch that answers the routes it is given with Cloudflare's envelope
 * and records every call. An unmatched route answers 404 with code 7000.
 */
export function createFakeCfFetch(routes: FakeCfRoute[]): {
  fetch: FetchLike;
  calls: FakeCfCall[];
} {
  const calls: FakeCfCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const path = input.replace(CF_API, "");
    const method = init.method ?? "GET";
    const call: FakeCfCall = {
      method,
      path,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const pathOnly = path.split("?")[0] ?? path;
    for (const route of routes) {
      if (route.method !== method) continue;
      const match = route.path.exec(pathOnly);
      if (!match) continue;
      const reply = route.reply(match, call);
      const status = reply.status ?? 200;
      const envelope = {
        success: reply.success ?? status < 400,
        errors: reply.errors ?? [],
        result: reply.result ?? null,
        result_info: { page: 1, total_pages: reply.total_pages ?? 1 },
      };
      return new Response(JSON.stringify(envelope), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        success: false,
        errors: [{ code: 7000, message: "No route for that URI" }],
        result: null,
      }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  };
  return { fetch, calls };
}
