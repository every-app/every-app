import { describe, expect, it } from "vitest";
import { verifyWebhook } from "./webhooks";

const encoder = new TextEncoder();

async function hmacHex(
  secret: string,
  data: string | Uint8Array,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  const digest = await crypto.subtle.sign("HMAC", key, bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function post(headers: Record<string, string>, body: BodyInit | null): Request {
  return new Request("https://birds.example.com/hooks", {
    method: "POST",
    headers,
    body,
  });
}

const NOW = new Date("2026-11-01T12:00:00Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

describe("verifyWebhook: github", () => {
  // GitHub's documented test vector (docs.github.com, "Validating webhook deliveries").
  const secret = "It's a Secret to Everybody";
  const body = "Hello, World!";
  const signature =
    "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

  it("accepts GitHub's documented vector and returns the body and delivery id", async () => {
    const check = await verifyWebhook(
      post(
        { "x-hub-signature-256": signature, "x-github-delivery": "d-1" },
        body,
      ),
      { provider: "github", secret },
    );
    expect(check).toEqual({
      ok: true,
      body,
      deliveryId: "d-1",
      timestamp: null,
    });
  });

  it("refuses another secret, a changed body and a missing or malformed header", async () => {
    expect(
      await verifyWebhook(post({ "x-hub-signature-256": signature }, body), {
        provider: "github",
        secret: "not it",
      }),
    ).toEqual({ ok: false, reason: "mismatch" });
    expect(
      await verifyWebhook(
        post({ "x-hub-signature-256": signature }, `${body} `),
        {
          provider: "github",
          secret,
        },
      ),
    ).toEqual({ ok: false, reason: "mismatch" });
    expect(
      await verifyWebhook(post({}, body), { provider: "github", secret }),
    ).toEqual({ ok: false, reason: "missing_signature" });
    expect(
      await verifyWebhook(
        post(
          { "x-hub-signature-256": signature.replace("sha256=", "sha1=") },
          body,
        ),
        { provider: "github", secret },
      ),
    ).toEqual({ ok: false, reason: "malformed" });
  });

  it("accepts any of several secrets, so one can rotate", async () => {
    const check = await verifyWebhook(
      post({ "x-hub-signature-256": signature }, body),
      {
        provider: "github",
        secret: ["", "old secret", secret],
      },
    );
    expect(check.ok).toBe(true);
  });

  it("refuses with no_secret when no usable secret is given", async () => {
    expect(
      await verifyWebhook(post({ "x-hub-signature-256": signature }, body), {
        provider: "github",
        secret: ["", ""],
      }),
    ).toEqual({ ok: false, reason: "no_secret" });
  });

  it("signs the received bytes, not a decoded copy", async () => {
    const raw = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]); // not valid UTF-8
    const digest = await hmacHex(secret, raw);
    const check = await verifyWebhook(
      post({ "x-hub-signature-256": `sha256=${digest}` }, raw),
      {
        provider: "github",
        secret,
      },
    );
    expect(check.ok).toBe(true);
  });

  it("stops reading past maxBytes", async () => {
    const big = "x".repeat(2048);
    const digest = await hmacHex(secret, big);
    expect(
      await verifyWebhook(
        post({ "x-hub-signature-256": `sha256=${digest}` }, big),
        {
          provider: "github",
          secret,
          maxBytes: 1024,
        },
      ),
    ).toEqual({ ok: false, reason: "too_large" });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(big));
        controller.close();
      },
    });
    expect(
      await verifyWebhook(
        new Request("https://birds.example.com/hooks", {
          method: "POST",
          headers: { "x-hub-signature-256": `sha256=${digest}` },
          body: stream,
          duplex: "half",
        } as RequestInit),
        { provider: "github", secret, maxBytes: 1024 },
      ),
    ).toEqual({ ok: false, reason: "too_large" });
  });
});

describe("verifyWebhook: options and the body", () => {
  const secret = "It's a Secret to Everybody";
  const body = "Hello, World!";
  const signature =
    "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

  it("throws for a tolerance or limit that would turn its check off", async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      await expect(
        verifyWebhook(post({ "x-hub-signature-256": signature }, body), {
          provider: "github",
          secret,
          maxBytes: bad,
        }),
      ).rejects.toThrow(TypeError);
      await expect(
        verifyWebhook(post({ "x-hub-signature-256": signature }, body), {
          provider: "github",
          secret,
          toleranceSeconds: bad,
        }),
      ).rejects.toThrow(TypeError);
    }
  });

  it("refuses a body already read or a stream that fails, without throwing", async () => {
    const used = post({ "x-hub-signature-256": signature }, body);
    await used.text();
    expect(await verifyWebhook(used, { provider: "github", secret })).toEqual({
      ok: false,
      reason: "unreadable",
    });
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("connection reset"));
      },
    });
    expect(
      await verifyWebhook(
        new Request("https://birds.example.com/hooks", {
          method: "POST",
          headers: { "x-hub-signature-256": signature },
          body: failing,
          duplex: "half",
        } as RequestInit),
        { provider: "github", secret },
      ),
    ).toEqual({ ok: false, reason: "unreadable" });
  });
});

describe("verifyWebhook: slack", () => {
  const secret = "8f742231b10e8888abcd99yyyzzz85a5";
  const body = "token=xyz&team_id=T1&command=%2Fbirds&text=support%3A+hi";

  async function slackHeaders(timestamp: number, payload = body) {
    return {
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": `v0=${await hmacHex(secret, `v0:${timestamp}:${payload}`)}`,
    };
  }

  it("accepts a signature over v0:<timestamp>:<body> inside the window", async () => {
    const check = await verifyWebhook(
      post(await slackHeaders(NOW_SECONDS - 60), body),
      {
        provider: "slack",
        secret,
        now: NOW,
      },
    );
    expect(check).toEqual({
      ok: true,
      body,
      deliveryId: null,
      timestamp: NOW_SECONDS - 60,
    });
  });

  it("refuses a timestamp outside the window before reading the body", async () => {
    const check = await verifyWebhook(
      post(await slackHeaders(NOW_SECONDS - 301), body),
      {
        provider: "slack",
        secret,
        now: NOW,
      },
    );
    expect(check).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses a signature replayed under another timestamp", async () => {
    const headers = await slackHeaders(NOW_SECONDS - 400);
    headers["x-slack-request-timestamp"] = String(NOW_SECONDS);
    expect(
      await verifyWebhook(post(headers, body), {
        provider: "slack",
        secret,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "mismatch" });
  });

  it("refuses a missing timestamp or a non-v0 signature as malformed", async () => {
    const headers = await slackHeaders(NOW_SECONDS);
    expect(
      await verifyWebhook(
        post({ "x-slack-signature": headers["x-slack-signature"] }, body),
        {
          provider: "slack",
          secret,
          now: NOW,
        },
      ),
    ).toEqual({ ok: false, reason: "malformed" });
    expect(
      await verifyWebhook(
        post(
          {
            ...headers,
            "x-slack-signature": headers["x-slack-signature"].replace(
              "v0=",
              "v1=",
            ),
          },
          body,
        ),
        { provider: "slack", secret, now: NOW },
      ),
    ).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("verifyWebhook: everyapp", () => {
  const secret = "whsec_0123456789abcdef0123456789abcdef";
  const body = JSON.stringify({ id: "evt_1", type: "member.removed" });

  it("accepts a Gateway event delivery and returns its event id", async () => {
    const digest = await hmacHex(secret, `${NOW_SECONDS}.${body}`);
    const check = await verifyWebhook(
      post(
        {
          "x-everyapp-signature": `t=${NOW_SECONDS},v1=${"0".repeat(64)},v1=${digest}`,
          "x-everyapp-event-id": "evt_1",
        },
        body,
      ),
      { provider: "everyapp", secret, now: NOW },
    );
    expect(check).toEqual({
      ok: true,
      body,
      deliveryId: "evt_1",
      timestamp: NOW_SECONDS,
    });
  });

  it("refuses a stale delivery and a malformed header", async () => {
    const stale = NOW_SECONDS - 3600;
    const digest = await hmacHex(secret, `${stale}.${body}`);
    expect(
      await verifyWebhook(
        post({ "x-everyapp-signature": `t=${stale},v1=${digest}` }, body),
        {
          provider: "everyapp",
          secret,
          now: NOW,
        },
      ),
    ).toEqual({ ok: false, reason: "expired" });
    expect(
      await verifyWebhook(post({ "x-everyapp-signature": "v1=abc" }, body), {
        provider: "everyapp",
        secret,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "malformed" });
    const many = Array.from({ length: 5 }, () => `v1=${"0".repeat(64)}`);
    expect(
      await verifyWebhook(
        post(
          {
            "x-everyapp-signature": `t=${NOW_SECONDS},${many.join(",")},v1=${await hmacHex(secret, `${NOW_SECONDS}.${body}`)}`,
          },
          body,
        ),
        { provider: "everyapp", secret, now: NOW },
      ),
    ).toEqual({ ok: false, reason: "malformed" });
  });
});
