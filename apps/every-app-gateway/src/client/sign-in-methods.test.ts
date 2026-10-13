import { describe, expect, it } from "vitest";
import {
  accessEmailMismatchMessage,
  accessSignInErrorMessage,
  mayAutoContinue,
  shouldLinkAfterPasswordSignIn,
} from "./sign-in-methods";

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

describe("accessSignInErrorMessage", () => {
  it("explains each refusal in the provider's own name", () => {
    expect(
      accessSignInErrorMessage("ACCESS_NOT_INVITED", "Company SSO", true),
    ).toMatch(/Ask an admin to invite you/);
    expect(
      accessSignInErrorMessage("ACCESS_NOT_SET_UP", "Company SSO", true),
    ).toMatch(/hasn't been set up/);
    for (const code of ["ACCESS_ACCOUNT_DEACTIVATED", "BANNED_USER"]) {
      expect(accessSignInErrorMessage(code, "Company SSO", true)).toMatch(
        /deactivated/,
      );
    }
    expect(
      accessSignInErrorMessage("state_mismatch", "Company SSO", true),
    ).toBe("Signing in with Company SSO didn't finish. Please try again.");
  });

  it("asks for the password once to link an existing account, unless passwords are off", () => {
    expect(
      accessSignInErrorMessage("account_not_linked", "Company SSO", true),
    ).toMatch(/Sign in with its password once to connect Company SSO/);
    expect(
      accessSignInErrorMessage("account_not_linked", "Company SSO", false),
    ).toMatch(/password sign-in is off\. Ask an admin/);
    expect(shouldLinkAfterPasswordSignIn("account_not_linked")).toBe(true);
    expect(shouldLinkAfterPasswordSignIn("ACCESS_NOT_INVITED")).toBe(false);
    expect(shouldLinkAfterPasswordSignIn(undefined)).toBe(false);
  });
});

describe("behind the outer ring, an account Access doesn't know the browser by", () => {
  it("says who Access says is here, which account that isn't, and how to fix it", () => {
    const message = accessEmailMismatchMessage(
      "ben@company.example",
      "owner@acme.com",
    );
    expect(message).toContain(
      "You're signed in to Cloudflare Access as ben@company.example, but this account is owner@acme.com",
    );
    expect(message).toContain("sign in there as owner@acme.com");
    expect(message).toContain("ask an admin to invite ben@company.example");
    expect(accessEmailMismatchMessage(null, "owner@acme.com")).toMatch(
      /another email than owner@acme\.com/,
    );
  });

  it("explains the codes a refused sign-in comes back with", () => {
    expect(
      accessSignInErrorMessage(
        "ACCESS_EMAIL_MISMATCH",
        "Company SSO",
        true,
        "alice@acme.com",
      ),
    ).toMatch(
      /Cloudflare Access as alice@acme\.com, but you signed in with Company SSO as someone else/,
    );
    expect(
      accessSignInErrorMessage("ACCESS_REQUIRED", "Company SSO", true),
    ).toMatch(/didn't come through it/);
  });
});

describe("mayAutoContinue", () => {
  it("moves on, but not to the same place twice within a few seconds", () => {
    const storage = memoryStorage();
    const now = 1_000_000;
    expect(mayAutoContinue("https://todo.example.com/", storage, now)).toBe(
      true,
    );
    // Sent straight back: stop and ask.
    expect(
      mayAutoContinue("https://todo.example.com/", storage, now + 2_000),
    ).toBe(false);
    // Somewhere else, or later, is fine.
    expect(mayAutoContinue("/admin", storage, now + 3_000)).toBe(true);
    expect(
      mayAutoContinue("https://todo.example.com/", storage, now + 60_000),
    ).toBe(true);
  });

  it("moves on without storage", () => {
    expect(mayAutoContinue("/", null)).toBe(true);
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => undefined,
    };
    expect(mayAutoContinue("/", broken)).toBe(true);
  });
});
