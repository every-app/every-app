import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ $fetch: vi.fn() }));

vi.mock("@/src/lib/auth-client", () => ({
  authClient: { $fetch: mocks.$fetch },
}));

import { accessSignInErrorMessage, signInWithAccess } from "./access-sign-in";

const REDIRECT_URL = "everyapp:///sign-in";
const LINK = "https://gw.example.com/api/auth/mobile-sign-in/continue?id=abc";

function device(result: { type: string; url?: string }) {
  return {
    redirectURL: REDIRECT_URL,
    openAuthSession: vi.fn(async () => result),
  };
}

beforeEach(() => {
  mocks.$fetch.mockReset();
});

describe("signInWithAccess", () => {
  it("opens the gateway's link in the system browser and trades the code it comes back with", async () => {
    mocks.$fetch
      .mockResolvedValueOnce({
        data: { url: LINK, secret: "app-secret" },
        error: null,
      })
      .mockResolvedValueOnce({ data: { user: {} }, error: null });
    const browser = device({
      type: "success",
      url: `${REDIRECT_URL}?code=one-time-code`,
    });

    await expect(
      signInWithAccess("cloudflare-access", browser),
    ).resolves.toEqual({ status: "signed-in" });

    expect(mocks.$fetch).toHaveBeenNthCalledWith(1, "/mobile-sign-in/start", {
      method: "POST",
      body: { provider: "cloudflare-access", redirectURL: REDIRECT_URL },
    });
    // The secret goes to the gateway on the app's own request, never into
    // the browser.
    expect(browser.openAuthSession).toHaveBeenCalledWith(LINK, REDIRECT_URL);
    expect(mocks.$fetch).toHaveBeenNthCalledWith(2, "/mobile-sign-in/finish", {
      method: "POST",
      body: { code: "one-time-code", secret: "app-secret" },
    });
  });

  it("says why the gateway refused the sign-in", async () => {
    mocks.$fetch.mockResolvedValueOnce({
      data: { url: LINK, secret: "app-secret" },
      error: null,
    });
    const result = await signInWithAccess(
      "cloudflare-access",
      device({
        type: "success",
        url: `${REDIRECT_URL}?error=ACCESS_NOT_INVITED`,
      }),
    );
    expect(result).toEqual({ status: "refused", code: "ACCESS_NOT_INVITED" });
    expect(mocks.$fetch).toHaveBeenCalledTimes(1);
  });

  it("stops quietly when the browser is closed", async () => {
    mocks.$fetch.mockResolvedValueOnce({
      data: { url: LINK, secret: "app-secret" },
      error: null,
    });
    await expect(
      signInWithAccess("cloudflare-access", device({ type: "cancel" })),
    ).resolves.toEqual({ status: "canceled" });
    expect(mocks.$fetch).toHaveBeenCalledTimes(1);
  });

  it("reports a gateway that won't start or finish the sign-in", async () => {
    mocks.$fetch.mockResolvedValueOnce({
      data: null,
      error: { status: 404, code: "PROVIDER_NOT_FOUND" },
    });
    const browser = device({ type: "success" });
    await expect(
      signInWithAccess("cloudflare-access", browser),
    ).resolves.toEqual({ status: "refused", code: "PROVIDER_NOT_FOUND" });
    expect(browser.openAuthSession).not.toHaveBeenCalled();

    mocks.$fetch
      .mockResolvedValueOnce({
        data: { url: LINK, secret: "app-secret" },
        error: null,
      })
      .mockResolvedValueOnce({
        data: null,
        error: { status: 400, code: "INVALID_MOBILE_SIGN_IN_CODE" },
      });
    await expect(
      signInWithAccess(
        "cloudflare-access",
        device({ type: "success", url: `${REDIRECT_URL}?code=late` }),
      ),
    ).resolves.toEqual({
      status: "refused",
      code: "INVALID_MOBILE_SIGN_IN_CODE",
    });
  });
});

describe("accessSignInErrorMessage", () => {
  it("explains each refusal, and anything else as a retry", () => {
    expect(accessSignInErrorMessage("ACCESS_NOT_INVITED", "SSO")).toMatch(
      /invite you/,
    );
    expect(accessSignInErrorMessage("BANNED_USER", "SSO")).toMatch(
      /deactivated/,
    );
    expect(accessSignInErrorMessage("account_not_linked", "SSO")).toMatch(
      /Connect SSO in the account menu/,
    );
    expect(accessSignInErrorMessage("whatever", "SSO")).toBe(
      "Signing in with SSO didn't finish. Please try again.",
    );
  });
});
