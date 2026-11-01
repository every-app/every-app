import { describe, expect, it, vi } from "vitest";
import {
  EMAIL_PROVIDERS,
  emailProviderStatus,
  selectEmailProvider,
} from "./index";
import type { EmailProviderEnv } from "./types";

const binding = { send: vi.fn() };
const rest = {
  EMAIL_REST_API_TOKEN: "token",
  CLOUDFLARE_ACCOUNT_ID: "account",
};
const resend = { RESEND_API_KEY: "re_key" };

function selected(env: EmailProviderEnv): string {
  const selection = selectEmailProvider(env);
  return "provider" in selection ? selection.provider.id : selection.error;
}

describe("selectEmailProvider", () => {
  it("lists Cloudflare, then Resend", () => {
    expect(EMAIL_PROVIDERS.map((provider) => provider.id)).toEqual([
      "cloudflare",
      "resend",
    ]);
    expect(EMAIL_PROVIDERS.map((provider) => provider.label)).toEqual([
      "Cloudflare Email Sending",
      "Resend",
    ]);
  });

  it("takes an explicit EMAIL_PROVIDER, trimmed and in any case", () => {
    expect(
      selected({
        EMAIL: binding,
        ...rest,
        ...resend,
        EMAIL_PROVIDER: "resend",
      }),
    ).toBe("resend");
    expect(selected({ ...resend, ...rest, EMAIL_PROVIDER: " RESEND " })).toBe(
      "resend",
    );
    expect(
      selected({ EMAIL: binding, ...resend, EMAIL_PROVIDER: "Cloudflare" }),
    ).toBe("cloudflare");
  });

  it("without one, prefers a provider the operator gave settings over the binding alone", () => {
    expect(selected({ EMAIL: binding, ...rest, ...resend })).toBe("cloudflare");
    expect(selected({ ...rest, ...resend })).toBe("cloudflare");
    expect(selected({ EMAIL: binding, ...resend })).toBe("resend");
    expect(selected({ ...resend })).toBe("resend");
    expect(selected({ EMAIL: binding })).toBe("cloudflare");
    expect(selected({ ...rest })).toBe("cloudflare");
    // Blank settings are no settings.
    expect(selected({ EMAIL: binding, RESEND_API_KEY: "  " })).toBe(
      "cloudflare",
    );
    expect(selected({ EMAIL_PROVIDER: "", RESEND_API_KEY: "re_key" })).toBe(
      "resend",
    );
  });

  it("refuses an unknown EMAIL_PROVIDER, whatever is set up", () => {
    const selection = selectEmailProvider({
      EMAIL: binding,
      ...resend,
      EMAIL_PROVIDER: "sendgrid",
    });
    expect(selection).toEqual({
      error: "unknown_provider",
      message:
        'Email delivery is unavailable: EMAIL_PROVIDER is "sendgrid", which isn\'t an email provider. Set it to cloudflare or resend, or unset it.',
    });
  });

  it("refuses an explicit provider that isn't set up, naming its settings", () => {
    expect(
      selectEmailProvider({ EMAIL: binding, EMAIL_PROVIDER: "resend" }),
    ).toEqual({
      error: "not_configured",
      message:
        "Email delivery is unavailable: EMAIL_PROVIDER picks Resend, which isn't set up on this gateway. Set RESEND_API_KEY.",
    });
    expect(
      selectEmailProvider({ ...resend, EMAIL_PROVIDER: "cloudflare" }),
    ).toEqual({
      error: "not_configured",
      message:
        "Email delivery is unavailable: EMAIL_PROVIDER picks Cloudflare Email Sending, which isn't set up on this gateway. Set EMAIL_REST_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or give the Worker its EMAIL binding.",
    });
    // Half the REST pair, and a binding that can't send, are not set up.
    expect(
      selected({
        EMAIL: {},
        EMAIL_REST_API_TOKEN: "token",
        EMAIL_PROVIDER: "cloudflare",
      }),
    ).toBe("not_configured");
  });

  it("says nothing is set up when nothing is, naming both providers", () => {
    const selection = selectEmailProvider({});
    expect(selection).toMatchObject({ error: "not_configured" });
    expect("message" in selection && selection.message).toContain(
      "Cloudflare Email Sending (the EMAIL binding, or EMAIL_REST_API_TOKEN with CLOUDFLARE_ACCOUNT_ID) or Resend (RESEND_API_KEY)",
    );
  });
});

describe("emailProviderStatus", () => {
  it("names the provider that sends and every one that could", () => {
    expect(emailProviderStatus({ EMAIL: binding, ...resend })).toEqual({
      provider: "resend",
      configured: true,
      available: ["cloudflare", "resend"],
    });
    expect(
      emailProviderStatus({ EMAIL: binding, ...resend, EMAIL_PROVIDER: "x" }),
    ).toEqual({
      provider: null,
      configured: false,
      available: ["cloudflare", "resend"],
    });
    expect(emailProviderStatus({})).toEqual({
      provider: null,
      configured: false,
      available: [],
    });
  });
});
