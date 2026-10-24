import { describe, expect, it } from "vitest";
import {
  CLAIM_BACKOFF_MS,
  CLAIM_RETRY_WINDOW_MS,
  claimLinkOf,
  claimWithRetry,
  D1_POLL_MS,
  createEventLogClaimer,
  expireUnconsumedLinks,
  mintToken,
  ownerCredentials,
  parseEventLogLine,
  postClaim,
  runD1Claimer,
  sha256Hex,
  tokenFromUrl,
} from "./claim";
import type { D1Client, FetchLike } from "./types";

const origin = "https://apps.everyapp-loop1.com";
const owner = ownerCredentials("owner@everyapp-loop1.com");
const TOKEN = "est_" + "a".repeat(43);
const LINK = `${origin}/setup#token=${TOKEN}`;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const noSleep = async () => {};

/** A fake gateway: records every claim POST and answers from a script. */
function fakeGateway(
  answers: Array<
    (body: Record<string, unknown>, init: RequestInit) => Response | Error
  >,
) {
  const calls: Array<{
    url: string;
    init: RequestInit;
    body: Record<string, unknown>;
  }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    calls.push({ url, init: init ?? {}, body });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)]!(
      body,
      init ?? {},
    );
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { fetchImpl, calls };
}

describe("links and lines", () => {
  it("finds the token in a setup link", () => {
    expect(tokenFromUrl(LINK)).toBe(TOKEN);
    expect(tokenFromUrl("https://x/setup")).toBeNull();
    expect(tokenFromUrl("est_short")).toBeNull();
  });
  it("reads a claim_owner action and nothing else", () => {
    const line = parseEventLogLine(
      `{"v":1,"ts":"2026-10-25T14:14:00.000Z","type":"action_required","action":"claim_owner","message":"Open this link","data":{"url":"${LINK}","expiresAt":"2026-10-26T14:14:00.000Z","waiting":true}}`,
    )!;
    expect(claimLinkOf(line)).toEqual({
      url: LINK,
      token: TOKEN,
      expiresAt: "2026-10-26T14:14:00.000Z",
    });
    expect(
      claimLinkOf(
        parseEventLogLine(
          '{"v":1,"ts":"x","type":"action_required","action":"cloudflare_login","message":"m","data":{"url":"https://dash"}}',
        )!,
      ),
    ).toBeNull();
    expect(parseEventLogLine("")).toBeNull();
    expect(parseEventLogLine("{bad")).toBeNull();
    expect(
      parseEventLogLine(
        '{"type":"invocation","pid":1,"argv":["setup"],"cwd":"/w","json":true,"isatty":{"stdin":false,"stdout":false,"stderr":false},"ci":false,"ts":"t"}',
      )?.type,
    ).toBe("invocation");
  });
  it("mints tokens in the CLI's format and hashes like it", () => {
    const token = mintToken();
    expect(token).toMatch(/^est_[A-Za-z0-9_-]{43}$/);
    expect(sha256Hex("x")).toBe(
      "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
    );
    expect(owner.password.length).toBeGreaterThanOrEqual(20);
    expect(owner.name).toBe("Loop Owner");
  });
});

describe("postClaim", () => {
  it("POSTs JSON with Origin set and reads ok", async () => {
    const gateway = fakeGateway([
      () => json(200, { ok: true, organizationId: "org_1" }),
    ]);
    const outcome = await postClaim({
      fetchImpl: gateway.fetchImpl,
      gatewayOrigin: origin,
      token: TOKEN,
      owner,
    });
    expect(outcome).toMatchObject({
      status: "claimed",
      organizationId: "org_1",
    });
    const call = gateway.calls[0]!;
    expect(call.url).toBe(`${origin}/api/setup/claim`);
    expect(call.init.method).toBe("POST");
    expect(call.init.redirect).toBe("manual");
    expect((call.init.headers as Record<string, string>)["origin"]).toBe(
      origin,
    );
    expect((call.init.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
    expect(call.body).toEqual({
      token: TOKEN,
      name: "Loop Owner",
      email: owner.email,
      password: owner.password,
    });
  });
  it("classifies the answers", async () => {
    const cases: Array<[Response | Error, string]> = [
      [json(403, { error: "INVALID_OR_EXPIRED_SETUP_LINK" }), "link_gone"],
      [json(409, { error: "USER_ALREADY_EXISTS" }), "already_claimed"],
      [json(409, { error: "ALREADY_CLAIMED" }), "already_claimed"],
      [json(400, { error: "INVALID_INPUT" }), "failed"],
      [json(403, { error: "ORIGIN_NOT_ALLOWED" }), "failed"],
      [new Response("<html>", { status: 522 }), "retryable"],
      [json(503, { error: "x" }), "retryable"],
      [
        Object.assign(new TypeError("fetch failed"), {
          cause: new Error("ECONNRESET"),
        }),
        "retryable",
      ],
    ];
    for (const [answer, status] of cases) {
      const gateway = fakeGateway([() => answer]);
      const outcome = await postClaim({
        fetchImpl: gateway.fetchImpl,
        gatewayOrigin: origin,
        token: TOKEN,
        owner,
      });
      expect(outcome.status, `${status}`).toBe(status);
    }
  });
  it("retries transport errors with backoff and gives up at the window", async () => {
    const sleeps: number[] = [];
    let t = 0;
    const gateway = fakeGateway([() => new TypeError("fetch failed")]);
    const outcome = await claimWithRetry(
      TOKEN,
      {
        fetchImpl: gateway.fetchImpl,
        gatewayOrigin: origin,
        owner,
        sleep: async (ms) => {
          sleeps.push(ms);
          t += ms;
        },
        now: () => new Date(t),
      },
      "event-log",
    );
    expect(outcome.status).toBe("retryable");
    expect(sleeps.slice(0, 5)).toEqual(CLAIM_BACKOFF_MS);
    expect(t).toBeLessThanOrEqual(CLAIM_RETRY_WINDOW_MS);
    expect(gateway.calls.length).toBeGreaterThan(5);
  });
});

describe("event-log claimer", () => {
  const actionLine = (token: string, ts: string) =>
    `{"v":1,"ts":"${ts}","type":"action_required","action":"claim_owner","message":"Open this link","data":{"url":"${origin}/setup#token=${token}","waiting":true}}`;
  it("claims within the tail: one POST, latency from the CLI's ts", async () => {
    const gateway = fakeGateway([() => json(200, { ok: true })]);
    const events: string[] = [];
    const claimer = createEventLogClaimer({
      fetchImpl: gateway.fetchImpl,
      gatewayOrigin: origin,
      owner,
      sleep: noSleep,
      now: () => new Date("2026-10-25T14:14:03.000Z"),
      onEvent: (e) => events.push(e.type),
    });
    claimer.onLine(
      '{"type":"invocation","pid":4,"argv":["setup","--json"],"cwd":"/w","json":true,"isatty":{"stdin":false,"stdout":false,"stderr":false},"ci":false,"ts":"2026-10-25T14:06:00.000Z"}',
    );
    claimer.onLine(
      '{"v":1,"ts":"2026-10-25T14:07:00.000Z","type":"step","step":"setup.gateway","status":"start"}',
    );
    claimer.onLine(actionLine(TOKEN, "2026-10-25T14:14:00.000Z"));
    const result = await claimer.settle();
    expect(result).toEqual({
      how: "event-log",
      linkEmittedAt: "2026-10-25T14:14:00.000Z",
      claimedAt: "2026-10-25T14:14:03.000Z",
      latencyS: 3,
      harnessSelfClaimed: false,
    });
    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]!.body["token"]).toBe(TOKEN);
    expect(events).toEqual(["link", "attempt", "claimed"]);
    claimer.onLine(
      actionLine("est_" + "b".repeat(43), "2026-10-25T14:20:00.000Z"),
    );
    await claimer.settle();
    expect(gateway.calls).toHaveLength(1);
  });
  it("re-claims on the newest link when the first is gone (setup reran)", async () => {
    const second = "est_" + "c".repeat(43);
    const gateway = fakeGateway([
      () => json(403, { error: "INVALID_OR_EXPIRED_SETUP_LINK" }),
      (body) =>
        body["token"] === second
          ? json(200, { ok: true })
          : json(403, { error: "INVALID_OR_EXPIRED_SETUP_LINK" }),
    ]);
    const claimer = createEventLogClaimer({
      fetchImpl: gateway.fetchImpl,
      gatewayOrigin: origin,
      owner,
      sleep: noSleep,
    });
    claimer.onLine(actionLine(TOKEN, "2026-10-25T14:14:00.000Z"));
    await claimer.settle();
    expect(claimer.result.how).toBe("none");
    claimer.onLine(actionLine(second, "2026-10-25T14:16:00.000Z"));
    const result = await claimer.settle();
    expect(result.how).toBe("event-log");
    expect(gateway.calls.map((c) => c.body["token"])).toEqual([TOKEN, second]);
  });
  it("reports a harness self-claim and stops", async () => {
    const gateway = fakeGateway([
      () => json(409, { error: "USER_ALREADY_EXISTS" }),
    ]);
    const claimer = createEventLogClaimer({
      fetchImpl: gateway.fetchImpl,
      gatewayOrigin: origin,
      owner,
      sleep: noSleep,
    });
    claimer.onLine(actionLine(TOKEN, "2026-10-25T14:14:00.000Z"));
    const result = await claimer.settle();
    expect(result.harnessSelfClaimed).toBe(true);
    expect(result.how).toBe("none");
  });
});

describe("D1-side claimer", () => {
  function fakeD1(
    rows: Array<{
      id: string;
      expires_at: number;
      consumed_at: number | null;
      token_hash: string;
    }>,
  ) {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const d1: D1Client = {
      async query(sql, params = []) {
        queries.push({ sql, params });
        if (sql.startsWith("SELECT")) {
          const now = params[0] as number;
          return rows
            .filter((r) => r.consumed_at === null && r.expires_at > now)
            .map((r) => ({ id: r.id, expires_at: r.expires_at }));
        }
        if (sql.startsWith("UPDATE owner_setup_tokens SET token_hash")) {
          const row = rows.find((r) => r.id === params[1]);
          if (row && row.consumed_at === null)
            row.token_hash = params[0] as string;
          return [];
        }
        if (sql.startsWith("UPDATE owner_setup_tokens SET expires_at = 0")) {
          for (const r of rows) if (r.consumed_at === null) r.expires_at = 0;
          return [];
        }
        throw new Error(`unexpected sql ${sql}`);
      },
    };
    return { d1, queries, rows };
  }

  it("rewrites the active row's hash to a token it knows, then claims", async () => {
    const now = Date.parse("2026-10-25T14:14:00.000Z");
    const db = fakeD1([
      {
        id: "row-1",
        expires_at: now + 3600_000,
        consumed_at: null,
        token_hash: "theirs",
      },
    ]);
    let posted: string | null = null;
    const gateway = fakeGateway([
      (body) => {
        posted = body["token"] as string;
        return json(200, { ok: true });
      },
    ]);
    let t = now;
    const result = await runD1Claimer({
      d1: db.d1,
      fetchImpl: gateway.fetchImpl,
      gatewayOrigin: origin,
      owner,
      sleep: async (ms) => {
        t += ms;
      },
      now: () => new Date(t),
      maxPolls: 5,
    });
    expect(result.how).toBe("d1");
    expect(posted).toMatch(/^est_/);
    expect(db.rows[0]!.token_hash).toBe(sha256Hex(posted!));
    expect(
      db.queries.filter((q) => q.sql.startsWith("UPDATE"))[0]!.params,
    ).toEqual([sha256Hex(posted!), "row-1"]);
  });
  it("polls every 5 s until a row appears and gives up at maxPolls", async () => {
    const db = fakeD1([]);
    const gateway = fakeGateway([() => json(200, { ok: true })]);
    const sleeps: number[] = [];
    const result = await runD1Claimer({
      d1: db.d1,
      fetchImpl: gateway.fetchImpl,
      gatewayOrigin: origin,
      owner,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      maxPolls: 3,
    });
    expect(result.how).toBe("none");
    expect(sleeps).toEqual([D1_POLL_MS, D1_POLL_MS, D1_POLL_MS]);
    expect(gateway.calls).toHaveLength(0);
  });
  it("skips a row setup replaced (403) and finds the next one", async () => {
    const now = Date.parse("2026-10-25T14:14:00.000Z");
    const db = fakeD1([
      {
        id: "row-1",
        expires_at: now + 3600_000,
        consumed_at: null,
        token_hash: "a",
      },
    ]);
    const gateway = fakeGateway([
      () => json(403, { error: "INVALID_OR_EXPIRED_SETUP_LINK" }),
      () => json(200, { ok: true }),
    ]);
    let polls = 0;
    const result = await runD1Claimer({
      d1: db.d1,
      fetchImpl: gateway.fetchImpl,
      gatewayOrigin: origin,
      owner,
      sleep: async () => {
        polls += 1;
        if (polls === 1)
          db.rows.push({
            id: "row-2",
            expires_at: now + 7200_000,
            consumed_at: null,
            token_hash: "b",
          });
      },
      now: () => new Date(now),
      maxPolls: 4,
    });
    expect(result.how).toBe("d1");
    expect(gateway.calls).toHaveLength(2);
  });
  it("expires unconsumed links on exit", async () => {
    const db = fakeD1([
      {
        id: "r",
        expires_at: Date.now() + 1000,
        consumed_at: null,
        token_hash: "h",
      },
    ]);
    await expireUnconsumedLinks(db.d1);
    expect(db.rows[0]!.expires_at).toBe(0);
  });
});
