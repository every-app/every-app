/**
 * The `email` capability end to end through the AppGateway entrypoint, with
 * the gateway's real mail module (server/email/sendEmail.ts) on a fake
 * EMAIL binding (or a mocked Resend API) and in-memory budget counters.
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

const workerEnv = vi.hoisted(() => ({
  GATEWAY_DEPLOYMENT_MODE: "self_hosted" as string,
  BETTER_AUTH_SECRET: "test-secret-0123456789abcdefghijklmnopqrstuv",
  EMAIL: undefined as { send: ReturnType<typeof vi.fn> } | undefined,
  EMAIL_REST_API_TOKEN: undefined as string | undefined,
  CLOUDFLARE_ACCOUNT_ID: undefined as string | undefined,
  RESEND_API_KEY: undefined as string | undefined,
  EMAIL_PROVIDER: undefined as string | undefined,
  EMAIL_FROM: undefined as string | undefined,
  EMAIL_FROM_NAME: undefined as string | undefined,
}));

// The daily mail budgets' counters, in memory: key -> count.
const counters = vi.hoisted(() => new Map<string, number>());

vi.mock("cloudflare:workers", () => ({ env: workerEnv }));
vi.mock("@/server/repositories/RateLimitCounterRepository", () => ({
  RateLimitCounterRepository: {
    read: async (keys: string[]) =>
      new Map(
        keys.flatMap((key) =>
          counters.has(key) ? [[key, counters.get(key)!]] : [],
        ),
      ),
    increment: async (keys: string[]) => {
      for (const key of keys) counters.set(key, (counters.get(key) ?? 0) + 1);
    },
  },
}));

import { mintIdentityJwt } from "@every-app/sdk/internal";
import { InMemoryAppRegistry, type RegisteredApp } from "@every-app/perimeter";
import { validateManifest } from "@every-app/perimeter/manifest";
import {
  clearAppCallerCacheForTests,
  handleAppGatewayRequest,
  type AppCallerProps,
} from "@/server/app-gateway-entrypoint";

let privateKeyPem: string;
let publicKeyPem: string;

beforeAll(() => {
  const keys = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  privateKeyPem = keys.privateKey;
  publicKeyPem = keys.publicKey;
});

const send = vi.fn();
let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clearAppCallerCacheForTests();
  counters.clear();
  send.mockReset().mockResolvedValue({ messageId: "<sent-1@example.com>" });
  workerEnv.GATEWAY_DEPLOYMENT_MODE = "self_hosted";
  workerEnv.EMAIL = { send };
  workerEnv.EMAIL_REST_API_TOKEN = undefined;
  workerEnv.CLOUDFLARE_ACCOUNT_ID = undefined;
  workerEnv.RESEND_API_KEY = undefined;
  workerEnv.EMAIL_PROVIDER = undefined;
  workerEnv.EMAIL_FROM = "noreply@gateway.example.com";
  workerEnv.EMAIL_FROM_NAME = "EveryApp";
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const PROPS: AppCallerProps = {
  organizationId: "org-1",
  appId: "inbox",
  workerName: "every-acme-inbox",
};
const SEND = "/api/integrations/email/send";
const STATUS = "/api/integrations/email";
const INBOX = {
  capabilities: {
    email: {
      access: "write",
      why: "Sends from the organization's mailboxes.",
    },
  },
};
/** What the installation's registry row holds (`everyapp email set --sender`). */
const SENDERS = ["*@mail.example.com", "ceo@example.com"];
const MESSAGE = {
  to: "customer@example.net",
  subject: "Re: your order (private subject)",
  text: "Private body text.",
  html: "<p>Private body html.</p>",
};

function app(
  manifest: Record<string, unknown> = INBOX,
  overrides: Partial<RegisteredApp> = {},
): RegisteredApp {
  return {
    appId: "inbox",
    hostname: "inbox.example.com",
    workerName: "every-acme-inbox",
    tier: "service_binding",
    scope: "org",
    organizationId: "org-1",
    status: "active",
    manifest: validateManifest({ id: "inbox", ...manifest }),
    emailSenders: SENDERS,
    ...overrides,
  };
}

function call(
  options: {
    path?: string;
    method?: string;
    body?: unknown;
    rawBody?: BodyInit;
    headers?: Record<string, string>;
    manifest?: Record<string, unknown>;
    registered?: RegisteredApp;
  } = {},
) {
  const method = options.method ?? (options.path === STATUS ? "GET" : "POST");
  return handleAppGatewayRequest({
    request: new Request(
      `http://every-app-gateway.internal${options.path ?? SEND}`,
      {
        method,
        headers: { "content-type": "application/json", ...options.headers },
        body:
          method === "GET"
            ? undefined
            : (options.rawBody ?? JSON.stringify(options.body ?? MESSAGE)),
      },
    ),
    props: PROPS,
    registry: new InMemoryAppRegistry([
      options.registered ?? app(options.manifest),
    ]),
    env: {
      GATEWAY_DEPLOYMENT_MODE: workerEnv.GATEWAY_DEPLOYMENT_MODE,
      JWT_PUBLIC_KEY: publicKeyPem,
      GATEWAY_URL: "https://home.example.com",
    },
    organizations: { isAttributable: async () => true },
  });
}

async function expectRefusal(
  response: Promise<Response>,
  status: number,
  code: string,
): Promise<Record<string, unknown>> {
  const refused = await response;
  expect(refused.status).toBe(status);
  expect(refused.headers.get("x-everyapp-error")).toBe(code);
  const body = (await refused.json()) as Record<string, unknown>;
  expect(body).toMatchObject({ code });
  return body;
}

function identity(
  channel: "web" | "mcp",
  scopes?: string[],
  orgId = "org-1",
): Promise<string> {
  return mintIdentityJwt(privateKeyPem, {
    subject: {
      sub: "user-1",
      email: "user@example.com",
      orgId,
      orgRole: "member",
    },
    audience: "every-acme-inbox",
    issuer: "https://home.example.com",
    channel,
    ...(scopes ? { scopes } : {}),
  });
}

function mailLogs(): Record<string, unknown>[] {
  return log.mock.calls
    .map(([line]: unknown[]) => {
      try {
        return JSON.parse(String(line)) as Record<string, unknown>;
      } catch {
        return {};
      }
    })
    .filter(
      (entry: Record<string, unknown>) => entry["evt"] === "email.app.send",
    );
}

describe("POST /api/integrations/email/send", () => {
  it("sends as the gateway's sender by default, attributed to the request's user", async () => {
    const response = await call({
      headers: { "x-everyapp-identity": await identity("web") },
      body: { ...MESSAGE, replyTo: "support@mail.example.com" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      messageId: "<sent-1@example.com>",
      status: "delivered",
    });
    expect(send).toHaveBeenCalledWith({
      to: "customer@example.net",
      from: { email: "noreply@gateway.example.com", name: "EveryApp" },
      replyTo: "support@mail.example.com",
      subject: MESSAGE.subject,
      text: MESSAGE.text,
      html: MESSAGE.html,
    });
    expect(mailLogs()).toEqual([
      {
        evt: "email.app.send",
        organizationId: "org-1",
        appId: "inbox",
        worker: "every-acme-inbox",
        orgSource: "props",
        recipients: 1,
        recipientHash: expect.stringMatching(/^[0-9a-f]{32}$/),
        sender: "gateway",
        attribution: "user",
        userId: "user-1",
        status: "delivered",
      },
    ]);
  });

  it("never logs the subject, the bodies or a recipient's address", async () => {
    await call({
      body: {
        ...MESSAGE,
        attachments: [
          {
            filename: "secret-plan.pdf",
            contentType: "application/pdf",
            content: "JVBERi0xLjQK",
          },
        ],
      },
    });
    await call({ body: { ...MESSAGE, from: "x@other.example" } });
    const everything = log.mock.calls
      .map(([line]: unknown[]) => String(line))
      .join("\n");
    expect(mailLogs()).toHaveLength(2);
    for (const secret of [
      "private subject",
      "Private body",
      "customer@example.net",
      "secret-plan",
      "JVBERi0x",
    ]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("sends as an app sender the installation allows, by a domain or an exact address", async () => {
    for (const from of [
      { address: "Support@Mail.Example.com", name: "Acme Support" },
      { address: "ceo@example.com" },
    ]) {
      const response = await call({ body: { ...MESSAGE, from } });
      expect(response.status).toBe(200);
    }
    expect(send.mock.calls[0]![0]).toMatchObject({
      from: { email: "Support@Mail.Example.com", name: "Acme Support" },
    });
    expect(send.mock.calls[1]![0]).toMatchObject({ from: "ceo@example.com" });
    expect(mailLogs().map((line) => line["sender"])).toEqual(["app", "app"]);
  });

  it.each([
    ["an unlisted domain", "x@other.example"],
    ["a subdomain of a listed one", "x@sub.mail.example.com"],
    ["another address on an exact one's domain", "cfo@example.com"],
  ])("refuses %s as the sender", async (_case, from) => {
    const body = await expectRefusal(
      call({ body: { ...MESSAGE, from } }),
      403,
      "email_sender_not_allowed",
    );
    expect(body["message"]).toContain("everyapp email set --sender");
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses any app sender when the installation has none", async () => {
    // An empty list, and a registry that doesn't carry the row's column.
    const { emailSenders: _absent, ...noColumn } = app();
    for (const registered of [app(INBOX, { emailSenders: [] }), noColumn]) {
      await expectRefusal(
        call({
          registered,
          body: { ...MESSAGE, from: "support@mail.example.com" },
        }),
        403,
        "email_sender_not_allowed",
      );
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("ignores senders a manifest snapshot still carries", async () => {
    // A row deployed before the lists moved to the installation: the
    // lenient manifest schema keeps `senders`, and the gateway reads none.
    await expectRefusal(
      call({
        registered: app(
          {
            capabilities: {
              email: { access: "write", senders: ["*@old.example"] },
            },
          },
          { emailSenders: [] },
        ),
        body: { ...MESSAGE, from: "support@old.example" },
      }),
      403,
      "email_sender_not_allowed",
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("grants nothing to an app whose manifest doesn't list email, whatever its row says", async () => {
    await expectRefusal(
      call({
        registered: app({}, { emailSenders: ["*@mail.example.com"] }),
        body: { ...MESSAGE, from: "support@mail.example.com" },
      }),
      403,
      "capability_not_requested",
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses app senders on a hosted gateway, and sends as its own", async () => {
    workerEnv.GATEWAY_DEPLOYMENT_MODE = "hosted";
    const body = await expectRefusal(
      call({ body: { ...MESSAGE, from: "support@mail.example.com" } }),
      403,
      "email_sender_not_allowed",
    );
    expect(body["message"]).toContain("ask the platform");
    expect((await call()).status).toBe(200);
  });

  it("refuses an app whose manifest doesn't list email, before anything else", async () => {
    for (const manifest of [
      {},
      { capabilities: { dataforseo: { access: "read" } } },
      // The registry is tolerant; only `write` grants sending.
      { capabilities: { email: { access: "read" } } },
    ]) {
      await expectRefusal(call({ manifest }), 403, "capability_not_requested");
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a method the route doesn't take, and a route email doesn't declare", async () => {
    await expectRefusal(
      call({ path: SEND, method: "GET" }),
      405,
      "integration_method_not_allowed",
    );
    await expectRefusal(
      call({ path: "/api/integrations/email/sendmany" }),
      400,
      "invalid_integration_route",
    );
  });

  it("refuses an agent's read-only connection, and sends for one that may write", async () => {
    await expectRefusal(
      call({
        headers: { "x-everyapp-identity": await identity("mcp", ["mcp:read"]) },
      }),
      403,
      "integration_read_only",
    );
    expect(send).not.toHaveBeenCalled();
    const response = await call({
      headers: {
        "x-everyapp-identity": await identity("mcp", ["mcp:read", "mcp:write"]),
      },
    });
    expect(response.status).toBe(200);
  });

  it.each([
    ["no recipient", { ...MESSAGE, to: [] }],
    ["a bad address", { ...MESSAGE, to: "not-an-address" }],
    ["no body", { to: "a@example.net", subject: "Hi" }],
    ["a From header", { ...MESSAGE, headers: { From: "ceo@other.example" } }],
    ["an unknown field", { ...MESSAGE, reply_to: "x@example.net" }],
  ])("refuses a message with %s", async (_case, body) => {
    await expectRefusal(call({ body }), 400, "email_invalid_message");
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a body that isn't JSON", async () => {
    await expectRefusal(
      call({ rawBody: "to=a@example.net" }),
      400,
      "email_invalid_message",
    );
  });

  it("refuses a message over 5 MiB as it streams, whatever length it claims", async () => {
    const big = "x".repeat(5 * 1024 * 1024);
    await expectRefusal(
      call({ body: { ...MESSAGE, text: big } }),
      413,
      "email_message_too_large",
    );
    // A body streamed without a length still stops at the cap.
    const chunk = new TextEncoder().encode("x".repeat(1024 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 8) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const response = handleAppGatewayRequest({
      request: new Request(`http://every-app-gateway.internal${SEND}`, {
        method: "POST",
        body: stream,
        duplex: "half",
      } as RequestInit),
      props: PROPS,
      registry: new InMemoryAppRegistry([app()]),
      env: { GATEWAY_DEPLOYMENT_MODE: "self_hosted" },
      organizations: { isAttributable: async () => true },
    });
    await expectRefusal(response, 413, "email_message_too_large");
    expect(sent).toBeLessThan(8);
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses when the gateway has no sender, naming the settings and the runbook", async () => {
    workerEnv.EMAIL_FROM = undefined;
    const body = await expectRefusal(call(), 503, "integration_not_configured");
    expect(body["message"]).toContain("EMAIL_FROM");
    expect(body["message"]).toContain("EMAIL_FROM_NAME");
    expect(body["message"]).toContain(
      "Cloudflare Email Sending (the EMAIL binding, or EMAIL_REST_API_TOKEN with CLOUDFLARE_ACCOUNT_ID) or Resend (RESEND_API_KEY); EMAIL_PROVIDER picks one when both are set",
    );
    expect(body["message"]).toContain("docs/runbooks/email-sending-setup.md");
  });

  it("refuses when EMAIL_PROVIDER picks a provider that isn't set up, sending nothing", async () => {
    workerEnv.EMAIL_PROVIDER = "resend";
    await expectRefusal(call(), 503, "integration_not_configured");
    expect(send).not.toHaveBeenCalled();
    expect(counters.size).toBe(0);
  });

  it("spends one per recipient, per address and for the gateway, and refuses with Retry-After once an address is spent", async () => {
    // Self-hosted: 100 app mails a day to one address.
    for (let i = 0; i < 100; i += 1) {
      const response = await call();
      expect(response.status).toBe(200);
    }
    const refused = await call();
    await expectRefusal(
      Promise.resolve(refused.clone()),
      429,
      "email_budget_exhausted",
    );
    const retryAfter = Number(refused.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(24 * 60 * 60);
    expect(send).toHaveBeenCalledTimes(100);

    // The spent address refuses the whole message; the others get theirs.
    await expectRefusal(
      call({
        body: {
          ...MESSAGE,
          to: ["other@example.net"],
          cc: ["CUSTOMER@example.net"],
        },
      }),
      429,
      "email_budget_exhausted",
    );
    expect(
      (await call({ body: { ...MESSAGE, to: "other@example.net" } })).status,
    ).toBe(200);

    // A three-recipient mail counts three against the gateway, and the
    // keys are per kind and address, never per organization.
    counters.clear();
    await call({
      body: {
        ...MESSAGE,
        to: ["a@example.net", "b@example.net"],
        bcc: ["c@example.net", "A@example.net"],
      },
    });
    const day = new Date().toISOString().slice(0, 10);
    expect(counters.get(`mail:app:gateway:${day}`)).toBe(3);
    const keys = [...counters.keys()];
    expect(keys).toHaveLength(4);
    expect(keys.filter((key) => key.startsWith("mail:app:to:"))).toHaveLength(
      3,
    );
    expect(keys.join(" ")).not.toContain("org-1");
    expect(keys.join(" ")).not.toContain("example.net");
  });

  it("caps app mail for the whole gateway", async () => {
    const day = new Date().toISOString().slice(0, 10);
    counters.set(`mail:app:gateway:${day}`, 4_999);
    await expectRefusal(
      call({ body: { ...MESSAGE, to: ["a@example.net", "b@example.net"] } }),
      429,
      "email_budget_exhausted",
    );
    expect((await call()).status).toBe(200);
  });

  it("budgets a hosted gateway's app mail tighter per address", async () => {
    workerEnv.GATEWAY_DEPLOYMENT_MODE = "hosted";
    for (let i = 0; i < 20; i += 1) expect((await call()).status).toBe(200);
    await expectRefusal(call(), 429, "email_budget_exhausted");
  });

  it.each([
    ["E_SENDER_NOT_VERIFIED", 422, "email_sender_not_verified"],
    ["E_SENDER_DOMAIN_NOT_AVAILABLE", 422, "email_sender_not_verified"],
    ["E_RATE_LIMIT_EXCEEDED", 429, "email_provider_limited"],
    ["E_DAILY_LIMIT_EXCEEDED", 429, "email_provider_limited"],
    ["E_HEADER_NOT_ALLOWED", 400, "email_invalid_message"],
    ["E_DELIVERY_FAILED", 502, "email_send_failed"],
  ])("maps the provider's %s to %i %s", async (providerCode, status, code) => {
    send.mockRejectedValue(
      Object.assign(new Error("provider says no"), { code: providerCode }),
    );
    const body = await expectRefusal(
      call({ body: { ...MESSAGE, from: "support@mail.example.com" } }),
      status,
      code,
    );
    if (code === "email_sender_not_verified") {
      expect(body["message"]).toContain(
        "cf email-sending subdomains create -z mail.example.com --name mail.example.com",
      );
    }
    expect(mailLogs().at(-1)).toMatchObject({
      status: "refused",
      reason: code,
    });
  });

  it("passes cc, bcc, headers and attachments through to the binding as base64", async () => {
    const response = await call({
      body: {
        ...MESSAGE,
        to: ["a@example.net", "b@example.net"],
        cc: "c@example.net",
        bcc: ["d@example.net"],
        headers: {
          "In-Reply-To": "<prev@example.net>",
          References: "<prev@example.net>",
        },
        attachments: [
          {
            filename: "invoice.pdf",
            contentType: "application/pdf",
            content: "JVBERi0xLjQK",
          },
          {
            filename: "logo.png",
            contentType: "image/png",
            content: "iVBORw0KGgo=",
            disposition: "inline",
            contentId: "logo",
          },
        ],
      },
    });
    expect(response.status).toBe(200);
    expect(send.mock.calls[0]![0]).toMatchObject({
      to: ["a@example.net", "b@example.net"],
      cc: ["c@example.net"],
      bcc: ["d@example.net"],
      headers: {
        "In-Reply-To": "<prev@example.net>",
        References: "<prev@example.net>",
      },
      attachments: [
        {
          disposition: "attachment",
          filename: "invoice.pdf",
          type: "application/pdf",
          content: "JVBERi0xLjQK",
        },
        {
          disposition: "inline",
          contentId: "logo",
          filename: "logo.png",
          type: "image/png",
          content: "iVBORw0KGgo=",
        },
      ],
    });
    expect(mailLogs().at(-1)).toMatchObject({ recipients: 4 });
  });
});

describe("app mail through Resend", () => {
  const resendAnswer = (status: number, body: unknown) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json(body, { status }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  beforeEach(() => {
    workerEnv.RESEND_API_KEY = "re_test_key";
  });

  it("sends through Resend, not the binding, with the app's sender, cc and attachments", async () => {
    const fetchMock = resendAnswer(200, { id: "resend-msg-1" });
    const response = await call({
      body: {
        ...MESSAGE,
        cc: "c@example.net",
        from: { address: "support@mail.example.com", name: "Acme Support" },
        attachments: [
          {
            filename: "invoice.pdf",
            contentType: "application/pdf",
            content: "JVBERi0xLjQK",
          },
        ],
      },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      messageId: "resend-msg-1",
      status: "delivered",
    });
    expect(send).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(JSON.parse(init.body as string)).toEqual({
      from: "Acme Support <support@mail.example.com>",
      to: ["customer@example.net"],
      cc: ["c@example.net"],
      subject: MESSAGE.subject,
      text: MESSAGE.text,
      html: MESSAGE.html,
      attachments: [
        {
          filename: "invoice.pdf",
          content: "JVBERi0xLjQK",
          content_type: "application/pdf",
        },
      ],
    });
    expect(mailLogs().at(-1)).toMatchObject({
      status: "delivered",
      sender: "app",
    });
  });

  it.each([
    [
      403,
      {
        name: "validation_error",
        message: "The mail.example.com domain is not verified.",
      },
      422,
      "email_sender_not_verified",
    ],
    [
      429,
      {
        name: "daily_quota_exceeded",
        message: "You have exceeded your daily email sending quota.",
      },
      429,
      "email_provider_limited",
    ],
    [
      422,
      { name: "invalid_attachment", message: "Attachment must have content." },
      400,
      "email_invalid_message",
    ],
    [
      401,
      { name: "missing_api_key", message: "Missing API Key" },
      502,
      "email_send_failed",
    ],
    [
      500,
      { name: "application_error", message: "An unexpected error occurred." },
      502,
      "email_send_failed",
    ],
  ])(
    "refuses Resend's %i %o as %i %s, in Resend's words",
    async (resendStatus, error, status, code) => {
      resendAnswer(resendStatus, { statusCode: resendStatus, ...error });
      const body = await expectRefusal(
        call({ body: { ...MESSAGE, from: "support@mail.example.com" } }),
        status,
        code,
      );
      expect(body["message"]).toMatch(/^Resend /);
      if (code === "email_sender_not_verified") {
        expect(body["message"]).toContain(
          "Its operator adds mail.example.com at https://resend.com/domains",
        );
      }
      expect(mailLogs().at(-1)).toMatchObject({
        status: "refused",
        reason: code,
      });
    },
  );

  it("goes back to the binding when EMAIL_PROVIDER picks Cloudflare", async () => {
    const fetchMock = resendAnswer(200, { id: "never" });
    workerEnv.EMAIL_PROVIDER = "cloudflare";
    expect((await call()).status).toBe(200);
    expect(send).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/integrations/email", () => {
  it("tells the app whether it can send, as whom, and which senders its installation gives it", async () => {
    const response = await call({ path: STATUS });
    await expect(response.json()).resolves.toEqual({
      capability: "email",
      requested: true,
      configured: true,
      ready: true,
      sender: { address: "noreply@gateway.example.com", name: "EveryApp" },
      senders: ["*@mail.example.com", "ceo@example.com"],
      provider: "cloudflare",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("names the provider the gateway sends with", async () => {
    workerEnv.RESEND_API_KEY = "re_test_key";
    await expect((await call({ path: STATUS })).json()).resolves.toMatchObject({
      ready: true,
      provider: "resend",
    });
    workerEnv.EMAIL_PROVIDER = "cloudflare";
    await expect((await call({ path: STATUS })).json()).resolves.toMatchObject({
      ready: true,
      provider: "cloudflare",
    });
    // A choice that isn't a provider leaves the gateway unable to send.
    workerEnv.EMAIL_PROVIDER = "sendgrid";
    await expect((await call({ path: STATUS })).json()).resolves.toMatchObject({
      configured: false,
      ready: false,
      sender: null,
      provider: null,
    });
  });

  it("says sending isn't set up when the gateway has no sender", async () => {
    workerEnv.EMAIL_FROM = undefined;
    await expect((await call({ path: STATUS })).json()).resolves.toMatchObject({
      requested: true,
      configured: false,
      ready: false,
      sender: null,
      senders: ["*@mail.example.com", "ceo@example.com"],
      provider: null,
    });
  });

  it("tells an app that doesn't list email nothing about the gateway's mail", async () => {
    await expect(
      (await call({ path: STATUS, manifest: {} })).json(),
    ).resolves.toEqual({
      capability: "email",
      requested: false,
      configured: false,
      ready: false,
      sender: null,
      senders: [],
      provider: null,
    });
  });

  it("echoes no senders on a hosted gateway, which refuses them", async () => {
    workerEnv.GATEWAY_DEPLOYMENT_MODE = "hosted";
    await expect((await call({ path: STATUS })).json()).resolves.toMatchObject({
      ready: true,
      senders: [],
    });
  });
});
