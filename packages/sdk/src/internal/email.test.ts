import { describe, expect, it } from "vitest";
import {
  EMAIL_SENDER_PATTERN,
  distinctRecipients,
  emailProviderRefusal,
  emailRestBody,
  parseEmailSender,
  parseEmailSendersEnv,
  parseSendEmailMessage,
  readEmailRestResponse,
  senderAllowed,
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

  it("reads the dev senders binding, and nothing from a bad one", () => {
    expect(parseEmailSendersEnv('["*@a.example"]')).toEqual(["*@a.example"]);
    expect(parseEmailSendersEnv("nope")).toEqual([]);
    expect(parseEmailSendersEnv(undefined)).toEqual([]);
  });

  it("reads the configured sender as the gateway always has", () => {
    expect(parseEmailSender("noreply@example.com", "Every App")).toEqual({
      address: "noreply@example.com",
      name: "Every App",
    });
    expect(
      parseEmailSender('"Every App" <noreply@example.com>', undefined),
    ).toEqual({
      address: "noreply@example.com",
      name: "Every App",
    });
    expect(parseEmailSender("noreply@example.com", undefined)).toBeNull();
    expect(parseEmailSender(undefined, "Every App")).toBeNull();
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
        from: { address: "noreply@example.com", name: "Every App" },
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
      from: { address: "noreply@example.com", name: "Every App" },
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
