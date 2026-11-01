import { describe, expect, it } from "vitest";
import {
  EMAIL_SENDER_PATTERN,
  chooseEmailProvider,
  distinctRecipients,
  emailListProblems,
  emailProviderRefusal,
  emailRestBody,
  emailSenderRefusal,
  parseEmailList,
  parseEmailSender,
  parseSendEmailMessage,
  readEmailRestResponse,
  senderAllowed,
  storedEmailList,
} from "./email";

const base = { to: "a@example.net", subject: "Hi", text: "Hello" };

function problemOf(input: unknown): string {
  const parsed = parseSendEmailMessage(input);
  if (parsed.ok) throw new Error("expected a problem");
  return parsed.problem;
}

describe("parseSendEmailMessage", () => {
  it("normalizes recipients to lists and keeps the rest", () => {
    const parsed = parseSendEmailMessage({
      ...base,
      to: " A@Example.net ",
      cc: "c@example.net",
      bcc: ["d@example.net"],
      html: "<p>Hello</p>",
      from: { address: "support@mail.example.com", name: " Support " },
      replyTo: "help@example.com",
      headers: { "In-Reply-To": "<x@y>", References: "<x@y>" },
      attachments: [
        {
          filename: "logo.png",
          contentType: "image/png",
          content: "iVBORw0KGgo=",
          disposition: "inline",
          contentId: "logo",
        },
      ],
    });
    expect(parsed).toEqual({
      ok: true,
      message: {
        to: ["A@Example.net"],
        cc: ["c@example.net"],
        bcc: ["d@example.net"],
        subject: "Hi",
        text: "Hello",
        html: "<p>Hello</p>",
        from: { address: "support@mail.example.com", name: "Support" },
        replyTo: { address: "help@example.com" },
        headers: { "In-Reply-To": "<x@y>", References: "<x@y>" },
        attachments: [
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
  });

  it.each([
    ["a non-object", "hello", /JSON object/],
    [
      "an unknown field",
      { ...base, reply_to: "x@y.z" },
      /Unknown field "reply_to"/,
    ],
    ["no recipient", { ...base, to: [] }, /at least one recipient/],
    [
      "a bad address",
      { ...base, to: "nobody" },
      /to\[0\] isn't an email address/,
    ],
    [
      "an address with a display name",
      { ...base, cc: ["Bob <bob@example.net>"] },
      /cc\[0\] isn't an email address/,
    ],
    [
      "an address with a line break",
      { ...base, to: "a@example.net\r\nBcc: x@evil.example" },
      /isn't an email address/,
    ],
    [
      "51 recipients",
      {
        ...base,
        to: Array.from({ length: 30 }, (_, i) => `t${i}@example.net`),
        bcc: Array.from({ length: 21 }, (_, i) => `b${i}@example.net`),
      },
      /at most 50 recipients .* \(this one: 51\)/,
    ],
    ["no subject", { to: "a@example.net", text: "x" }, /subject is a string/],
    ["a subject on two lines", { ...base, subject: "a\nb" }, /one line/],
    ["a long subject", { ...base, subject: "x".repeat(999) }, /998/],
    ["no body", { to: "a@example.net", subject: "x" }, /text or an html body/],
    ["an empty body", { ...base, text: "" }, /text or an html body/],
    [
      "a from with an unknown key",
      { ...base, from: { email: "a@b.co" } },
      /takes address and name/,
    ],
    [
      "a name with a line break",
      { ...base, from: { address: "a@b.co", name: "A\r\nB" } },
      /one line/,
    ],
    [
      "a From header",
      { ...base, headers: { From: "ceo@other.example" } },
      /From header comes from the message's own fields/,
    ],
    [
      "a lowercase reply-to header",
      { ...base, headers: { "reply-to": "x@other.example" } },
      /reply-to header/,
    ],
    [
      "a header value on two lines",
      { ...base, headers: { "X-A": "a\r\nBcc: x@y.z" } },
      /one line/,
    ],
    [
      "a header name with a colon",
      { ...base, headers: { "X-A:": "a" } },
      /isn't a header name/,
    ],
    [
      "a long header value",
      { ...base, headers: { "X-A": "x".repeat(2049) } },
      /2048 bytes/,
    ],
    [
      "21 headers",
      {
        ...base,
        headers: Object.fromEntries(
          Array.from({ length: 21 }, (_, i) => [`X-H${i}`, "v"]),
        ),
      },
      /at most 20 headers/,
    ],
    [
      "an attachment that isn't base64",
      {
        ...base,
        attachments: [
          {
            filename: "a.txt",
            contentType: "text/plain",
            content: "not base64!",
          },
        ],
      },
      /base64/,
    ],
    [
      "an attachment without a MIME type",
      {
        ...base,
        attachments: [
          { filename: "a.txt", contentType: "text", content: "YQ==" },
        ],
      },
      /MIME type/,
    ],
    [
      "an inline attachment without a content id",
      {
        ...base,
        attachments: [
          {
            filename: "a.png",
            contentType: "image/png",
            content: "YQ==",
            disposition: "inline",
          },
        ],
      },
      /needs a contentId/,
    ],
    [
      "33 attachments",
      {
        ...base,
        attachments: Array.from({ length: 33 }, () => ({
          filename: "a.txt",
          contentType: "text/plain",
          content: "YQ==",
        })),
      },
      /at most 32 attachments/,
    ],
  ])("refuses %s", (_case, input, problem) => {
    expect(problemOf(input)).toMatch(problem);
  });
});

describe("senders", () => {
  it.each([
    "*@mail.example.com",
    "support@mail.example.com",
    "a.b+c@x.co",
    "*@xn--80ak6aa92e.com",
  ])("takes %s as a manifest pattern", (pattern) => {
    expect(EMAIL_SENDER_PATTERN.test(pattern)).toBe(true);
  });

  it.each([
    "bad",
    "*@",
    "@example.com",
    "Support@example.com",
    "*@Example.com",
    "*.example.com",
    "a@b",
    "**@example.com",
    "a@-x.com",
  ])("refuses %s as a manifest pattern", (pattern) => {
    expect(EMAIL_SENDER_PATTERN.test(pattern)).toBe(false);
  });

  it("matches a wildcard on exactly its domain and an exact address alone, in any case", () => {
    const patterns = ["*@mail.example.com", "ceo@example.com"];
    expect(senderAllowed("support@mail.example.com", patterns)).toBe(true);
    expect(senderAllowed("Support@MAIL.example.com", patterns)).toBe(true);
    expect(senderAllowed("CEO@example.com", patterns)).toBe(true);
    expect(senderAllowed("x@sub.mail.example.com", patterns)).toBe(false);
    expect(senderAllowed("x@example.com", patterns)).toBe(false);
    expect(senderAllowed("x@evilmail.example.com", patterns)).toBe(false);
    expect(senderAllowed("x@mail.example.com.evil", patterns)).toBe(false);
    expect(senderAllowed("x@mail.example.com", [])).toBe(false);
  });

  it("counts a recipient once across to, cc and bcc", () => {
    expect(
      distinctRecipients({
        to: ["A@example.net", "b@example.net"],
        cc: ["a@example.net"],
        bcc: ["B@EXAMPLE.NET"],
      }),
    ).toEqual(["a@example.net", "b@example.net"]);
  });

  it("reads a senders list as JSON or a comma list, and nothing from a bad one", () => {
    expect(parseEmailList('["*@a.example"]')).toEqual(["*@a.example"]);
    expect(parseEmailList("*@a.example, b@c.example")).toEqual([
      "*@a.example",
      "b@c.example",
    ]);
    // A one-entry list no address matches.
    expect(parseEmailList("nope")).toEqual(["nope"]);
    expect(senderAllowed("x@nope", ["nope"])).toBe(false);
    expect(parseEmailList(undefined)).toEqual([]);
    expect(parseEmailList("[oops")).toEqual([]);
  });

  it("reads the configured sender as the gateway always has", () => {
    expect(parseEmailSender("noreply@example.com", "EveryApp")).toEqual({
      address: "noreply@example.com",
      name: "EveryApp",
    });
    expect(
      parseEmailSender('"EveryApp" <noreply@example.com>', undefined),
    ).toEqual({
      address: "noreply@example.com",
      name: "EveryApp",
    });
    expect(parseEmailSender("noreply@example.com", undefined)).toBeNull();
    expect(parseEmailSender(undefined, "EveryApp")).toBeNull();
  });
});

describe("an installation's lists", () => {
  const senders = (count: number) =>
    Array.from({ length: count }, (_, i) => `s${i}@example.com`);
  const addresses = (count: number) =>
    Array.from({ length: count }, (_, i) => `a${i}@example.com`);

  it.each([
    [
      "a bad sender",
      "senders",
      ["bad"],
      `"bad" isn't a sender: a sender is "*@<domain>" or "<local>@<domain>", in lowercase.`,
    ],
    [
      "an uppercase sender",
      "senders",
      ["Ben@example.com"],
      `"Ben@example.com" isn't a sender: a sender is "*@<domain>" or "<local>@<domain>", in lowercase.`,
    ],
    [
      "a duplicate sender",
      "senders",
      ["*@example.com", "*@example.com"],
      "*@example.com is listed twice.",
    ],
    ["21 senders", "senders", senders(21), "At most 20 senders, not 21."],
    [
      "an uppercase inbound address",
      "inbound",
      ["Support@example.com"],
      `"Support@example.com" isn't an inbound address: an inbound address is "*@<domain>" or "<local>@<domain>", in lowercase.`,
    ],
    [
      "a bare domain",
      "inbound",
      ["example.com"],
      `"example.com" isn't an inbound address: an inbound address is "*@<domain>" or "<local>@<domain>", in lowercase.`,
    ],
    [
      "a partial wildcard",
      "inbound",
      ["sup*@example.com"],
      `"sup*@example.com" isn't an inbound address: an inbound address is "*@<domain>" or "<local>@<domain>", in lowercase.`,
    ],
    [
      "a wildcard domain",
      "inbound",
      ["*@*.example.com"],
      `"*@*.example.com" isn't an inbound address: an inbound address is "*@<domain>" or "<local>@<domain>", in lowercase.`,
    ],
    [
      "a domain without a TLD",
      "inbound",
      ["support@localhost"],
      `"support@localhost" isn't an inbound address: an inbound address is "*@<domain>" or "<local>@<domain>", in lowercase.`,
    ],
    [
      "a duplicate address",
      "inbound",
      ["a@example.com", "a@example.com"],
      "a@example.com is listed twice.",
    ],
    [
      "an 81-character local part",
      "inbound",
      [`${"a".repeat(81)}@example.com`],
      `${"a".repeat(81)}@example.com is longer than Email Routing's 90 characters.`,
    ],
    [
      "51 addresses",
      "inbound",
      addresses(51),
      "At most 50 inbound addresses, not 51.",
    ],
  ] as const)("refuses %s", (_, kind, values, problem) => {
    expect(emailListProblems(kind, values)).toEqual([problem]);
  });

  it("accepts both lists within their limits", () => {
    expect(emailListProblems("senders", senders(20))).toEqual([]);
    expect(emailListProblems("inbound", addresses(50))).toEqual([]);
    expect(
      emailListProblems("inbound", [
        "*@example.com",
        "support@mail.example.com",
      ]),
    ).toEqual([]);
  });

  it("stores an empty list as null", () => {
    expect(storedEmailList([])).toBeNull();
    expect(parseEmailList(storedEmailList([]))).toEqual([]);
    const stored = storedEmailList(["*@example.com", "ceo@example.com"]);
    expect(stored).toBe('["*@example.com","ceo@example.com"]');
    expect(parseEmailList(stored)).toEqual([
      "*@example.com",
      "ceo@example.com",
    ]);
  });

  it("says what sets the senders, on the gateway and in dev", () => {
    const onGateway = emailSenderRefusal("ceo@other.example", "gateway");
    const inDev = emailSenderRefusal("ceo@other.example", "dev");
    for (const sentence of [onGateway, inDev]) {
      expect(sentence).toContain("This app may not send as ceo@other.example");
      expect(sentence).toContain("*@other.example");
      expect(sentence).toContain("everyapp email set --sender");
    }
    expect(onGateway).not.toContain(".dev.vars");
    expect(inDev).toContain(".dev.vars");
  });
});

describe("provider refusals", () => {
  it.each([
    ["E_SENDER_NOT_VERIFIED", 422, "email_sender_not_verified"],
    ["E_SENDER_DOMAIN_NOT_AVAILABLE", 422, "email_sender_not_verified"],
    ["E_RATE_LIMIT_EXCEEDED", 429, "email_provider_limited"],
    ["E_DAILY_LIMIT_EXCEEDED", 429, "email_provider_limited"],
    ["10004", 429, "email_provider_limited"],
    ["E_HEADER_NOT_ALLOWED", 400, "email_invalid_message"],
    ["10001", 400, "email_invalid_message"],
    ["E_DELIVERY_FAILED", 502, "email_send_failed"],
    [undefined, 502, "email_send_failed"],
  ])("maps %s to %i %s", (providerCode, status, code) => {
    expect(
      emailProviderRefusal(providerCode, "mail.example.com"),
    ).toMatchObject({
      status,
      code,
    });
  });

  it("names the onboarding command for an unverified sender domain", () => {
    expect(
      emailProviderRefusal("E_SENDER_NOT_VERIFIED", "mail.example.com").message,
    ).toContain(
      "cf email-sending subdomains create -z mail.example.com --name mail.example.com",
    );
  });

  it("words a Resend refusal for Resend, with the same statuses and codes", () => {
    expect(
      emailProviderRefusal(
        "E_SENDER_NOT_VERIFIED",
        "mail.example.com",
        "resend",
      ),
    ).toEqual({
      status: 422,
      code: "email_sender_not_verified",
      message: expect.stringContaining(
        "Its operator adds mail.example.com at https://resend.com/domains",
      ),
    });
    for (const [providerCode, status, code] of [
      ["E_RATE_LIMIT_EXCEEDED", 429, "email_provider_limited"],
      ["E_VALIDATION_ERROR", 400, "email_invalid_message"],
      ["application_error", 502, "email_send_failed"],
    ] as const) {
      const refusal = emailProviderRefusal(
        providerCode,
        "mail.example.com",
        "resend",
      );
      expect(refusal).toMatchObject({ status, code });
      expect(refusal.message).toMatch(/^Resend /);
      expect(refusal.message).not.toContain("Cloudflare");
    }
  });
});

describe("choosing the email provider", () => {
  const setUp =
    (cloudflare: "settings" | "binding" | null, resend: "settings" | null) =>
    (provider: "cloudflare" | "resend") =>
      provider === "cloudflare" ? cloudflare : resend;

  it("takes EMAIL_PROVIDER, trimmed and in any case, when it is set up", () => {
    expect(
      chooseEmailProvider(" Resend ", setUp("settings", "settings")),
    ).toEqual({ ok: true, provider: "resend" });
    expect(
      chooseEmailProvider("CLOUDFLARE", setUp("binding", "settings")),
    ).toEqual({ ok: true, provider: "cloudflare" });
  });

  it("refuses an EMAIL_PROVIDER that isn't set up, or isn't a provider", () => {
    expect(chooseEmailProvider("resend", setUp("binding", null))).toEqual({
      ok: false,
      error: "not_configured",
      requested: "resend",
    });
    expect(
      chooseEmailProvider("sendgrid", setUp("binding", "settings")),
    ).toEqual({ ok: false, error: "unknown_provider", requested: "sendgrid" });
  });

  it("without EMAIL_PROVIDER, takes the first with settings, then a binding alone", () => {
    const choose = (
      cloudflare: "settings" | "binding" | null,
      resend: "settings" | null,
    ) => chooseEmailProvider(undefined, setUp(cloudflare, resend));
    expect(choose("settings", "settings")).toMatchObject({
      provider: "cloudflare",
    });
    // The EMAIL binding every gateway declares doesn't outrank a key the
    // operator set.
    expect(choose("binding", "settings")).toMatchObject({ provider: "resend" });
    expect(choose("binding", null)).toMatchObject({ provider: "cloudflare" });
    expect(choose(null, "settings")).toMatchObject({ provider: "resend" });
    expect(choose(null, null)).toEqual({
      ok: false,
      error: "not_configured",
      requested: null,
    });
    // A blank EMAIL_PROVIDER is no choice.
    expect(chooseEmailProvider("  ", setUp(null, "settings"))).toMatchObject({
      provider: "resend",
    });
  });
});

describe("Email Sending's REST API", () => {
  it("takes snake_case fields, named addresses as objects", () => {
    expect(
      emailRestBody({
        to: ["a@example.net"],
        cc: ["c@example.net"],
        bcc: [],
        subject: "Hi",
        html: "<p>Hi</p>",
        from: { address: "noreply@example.com", name: "EveryApp" },
        replyTo: { address: "help@example.com" },
        headers: { "X-Thing": "1" },
        attachments: [
          {
            filename: "logo.png",
            contentType: "image/png",
            content: "YQ==",
            disposition: "inline",
            contentId: "logo",
          },
        ],
      }),
    ).toEqual({
      to: "a@example.net",
      cc: ["c@example.net"],
      from: { address: "noreply@example.com", name: "EveryApp" },
      reply_to: "help@example.com",
      subject: "Hi",
      html: "<p>Hi</p>",
      headers: { "X-Thing": "1" },
      attachments: [
        {
          content: "YQ==",
          filename: "logo.png",
          type: "image/png",
          disposition: "inline",
          content_id: "logo",
        },
      ],
    });
  });

  it("reads delivered, queued, partial and failed answers", () => {
    const ok = (result: object) =>
      readEmailRestResponse(200, { success: true, errors: [], result });
    expect(
      ok({
        message_id: "<m>",
        delivered: ["a@x.co"],
        queued: [],
        permanent_bounces: [],
      }),
    ).toEqual({ ok: true, messageId: "<m>", status: "delivered" });
    expect(
      ok({ delivered: [], queued: ["a@x.co"], permanent_bounces: [] }),
    ).toEqual({
      ok: true,
      status: "queued",
    });
    // Some reached: the message went out.
    expect(
      ok({ delivered: ["a@x.co"], queued: [], permanent_bounces: ["b@x.co"] }),
    ).toMatchObject({ ok: true, status: "delivered" });
    expect(
      ok({ delivered: [], queued: [], permanent_bounces: ["b@x.co"] }),
    ).toEqual({
      ok: false,
      message: "Email API permanently bounced every recipient.",
    });
    expect(
      readEmailRestResponse(400, {
        success: false,
        errors: [
          {
            code: 10001,
            message: "email.sending.error.invalid_request_schema",
          },
        ],
        result: null,
      }),
    ).toEqual({
      ok: false,
      providerCode: "10001",
      message: "email.sending.error.invalid_request_schema",
    });
    expect(readEmailRestResponse(429, null)).toMatchObject({
      ok: false,
      providerCode: "10004",
    });
  });
});
