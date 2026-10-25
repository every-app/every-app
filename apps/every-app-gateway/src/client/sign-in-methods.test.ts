import { describe, expect, it } from "vitest";
import { ACCESS_PROVIDER_ID as SERVER_ACCESS_PROVIDER_ID } from "@/auth/cloudflare-access/config";
import {
  ACCESS_PROVIDER_ID,
  accessEmailMismatchMessage,
  connectErrorPath,
  connectableProviders,
  mayAutoContinue,
  offeredProvidersText,
  shouldLinkAfterPasswordSignIn,
  signInErrorLabel,
  signInErrorMessage,
  signInErrorProvider,
  signInPageParts,
} from "./sign-in-methods";

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

describe("signInErrorMessage", () => {
  it("explains each refusal in the provider's own name", () => {
    expect(
      signInErrorMessage("ACCESS_NOT_INVITED", "Company SSO", true),
    ).toMatch(/Ask an admin to invite you/);
    expect(
      signInErrorMessage("ACCESS_NOT_SET_UP", "Company SSO", true),
    ).toMatch(/hasn't been set up/);
    for (const code of ["ACCESS_ACCOUNT_DEACTIVATED", "BANNED_USER"]) {
      expect(signInErrorMessage(code, "Company SSO", true)).toMatch(
        /deactivated/,
      );
    }
    expect(signInErrorMessage("state_mismatch", "Company SSO", true)).toBe(
      "Signing in with Company SSO didn't finish. Please try again.",
    );
  });

  it("asks for the password once to link an existing account, unless passwords are off", () => {
    expect(
      signInErrorMessage("account_not_linked", "Company SSO", true),
    ).toMatch(/Sign in with its password once to connect Company SSO/);
    expect(
      signInErrorMessage("account_not_linked", "Company SSO", false),
    ).toMatch(/password sign-in is off\. Ask an admin/);
    expect(shouldLinkAfterPasswordSignIn("account_not_linked")).toBe(true);
    expect(shouldLinkAfterPasswordSignIn("ACCESS_NOT_INVITED")).toBe(false);
    expect(shouldLinkAfterPasswordSignIn(undefined)).toBe(false);
  });
});

describe("signInErrorMessage for the sign-in providers", () => {
  it("explains each refusal of the membership policy in the provider's name", () => {
    expect(signInErrorMessage("SIGNIN_NOT_INVITED", "Google", true)).toBe(
      "You don't have an account on this gateway yet. Ask an admin to invite you.",
    );
    expect(signInErrorMessage("SIGNIN_NOT_SET_UP", "Google", true)).toMatch(
      /hasn't been set up yet/,
    );
    expect(
      signInErrorMessage("SIGNIN_EMAIL_NOT_VERIFIED", "GitHub", true),
    ).toBe(
      "GitHub hasn't verified this email address, so it can't be used here.",
    );
    expect(signInErrorMessage("email_not_verified", "Apple", true)).toBe(
      "Apple hasn't verified this email address, so it can't be used here.",
    );
    expect(
      signInErrorMessage("SIGNIN_ACCOUNT_DEACTIVATED", "Google", true),
    ).toMatch(/deactivated/);
    expect(
      signInErrorMessage("SIGNIN_PROVIDER_UNAVAILABLE", "Okta", true),
    ).toBe("Okta couldn't be reached. Try again in a moment.");
  });

  it("explains Better Auth's callback codes in the provider's name", () => {
    expect(signInErrorMessage("account_not_linked", "Google", true)).toBe(
      "An account with this email already exists. Sign in with its password once to connect Google; after that, Google signs you in.",
    );
    expect(signInErrorMessage("unable_to_link_account", "Google", true)).toBe(
      "Google hasn't verified that email, so it wasn't connected.",
    );
    expect(signInErrorMessage("email_does_not_match", "GitHub", true)).toMatch(
      /That GitHub identity has a different email/,
    );
    expect(
      signInErrorMessage(
        "account_already_linked_to_different_user",
        "GitHub",
        true,
      ),
    ).toMatch(/already connected to another account/);
    for (const code of [
      "email_not_found",
      "state_mismatch",
      "invalid_code",
      "unable_to_get_user_info",
      "",
    ]) {
      expect(signInErrorMessage(code, "Microsoft", true), code).toBe(
        "Signing in with Microsoft didn't finish. Please try again.",
      );
    }
  });
});

describe("which provider a refusal came back from", () => {
  const methods = {
    providers: [
      { id: "cloudflare-access", label: "Company SSO" },
      { id: "google", label: "Google" },
      { id: "github", label: "GitHub" },
    ],
  };

  it("is the provider= the page put on its error URL", () => {
    expect(
      signInErrorProvider(methods, "github", "account_not_linked"),
    ).toEqual({ id: "github", label: "GitHub" });
    expect(
      signInErrorProvider(methods, "google", "SIGNIN_NOT_INVITED"),
    ).toEqual({ id: "google", label: "Google" });
  });

  it("is Access for an Access code, and the first offered for an old link without provider=", () => {
    expect(
      signInErrorProvider(methods, undefined, "ACCESS_NOT_INVITED"),
    ).toEqual({ id: "cloudflare-access", label: "Company SSO" });
    expect(
      signInErrorProvider(methods, undefined, "account_not_linked"),
    ).toEqual({ id: "cloudflare-access", label: "Company SSO" });
    expect(signInErrorProvider(undefined, undefined, "x")).toBeNull();
  });

  it("is none for a provider that isn't offered, and the message names it from the catalog", () => {
    const missing = signInErrorProvider(methods, "apple", "SIGNIN_NOT_INVITED");
    expect(missing).toBeNull();
    expect(signInErrorLabel(missing, "apple")).toBe("Apple");
    expect(signInErrorLabel(missing, "okta")).toBe("your sign-in provider");
    expect(signInErrorLabel(null, undefined)).toBe("Cloudflare Access");
    expect(signInErrorLabel(null, "cloudflare-access")).toBe(
      "Cloudflare Access",
    );
    expect(signInErrorLabel({ id: "oidc", label: "Okta" }, "oidc")).toBe(
      "Okta",
    );
  });

  it("names the ways in for an invited person when passwords are off", () => {
    expect(offeredProvidersText(methods)).toBe("Company SSO, Google or GitHub");
    expect(
      offeredProvidersText({ providers: [{ id: "google", label: "Google" }] }),
    ).toBe("Google");
    expect(offeredProvidersText({ providers: [] })).toBe("Cloudflare Access");
    expect(offeredProvidersText(undefined)).toBe("Cloudflare Access");
  });

  it("offers Connect <label> in the account menu for each provider the account has no identity of", () => {
    expect(connectableProviders(methods, undefined)).toEqual([]);
    expect(
      connectableProviders(methods, ["credential", "google"]).map(
        (provider) => provider.label,
      ),
    ).toEqual(["Company SSO", "GitHub"]);
    expect(
      connectableProviders(methods, [
        "credential",
        "cloudflare-access",
        "google",
        "github",
      ]),
    ).toEqual([]);
    expect(connectErrorPath("google")).toBe("/sign-in?provider=google");
    expect(connectErrorPath("cloudflare-access")).toBe(
      "/sign-in?provider=cloudflare-access",
    );
  });

  it("knows Access by the gateway's own provider id", () => {
    expect(ACCESS_PROVIDER_ID).toBe(SERVER_ACCESS_PROVIDER_ID);
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
      signInErrorMessage(
        "ACCESS_EMAIL_MISMATCH",
        "Company SSO",
        true,
        "alice@acme.com",
      ),
    ).toMatch(
      /Cloudflare Access as alice@acme\.com, but you signed in with Company SSO as someone else/,
    );
    expect(signInErrorMessage("ACCESS_REQUIRED", "Company SSO", true)).toMatch(
      /didn't come through it/,
    );
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

describe("signInPageParts", () => {
  const base = {
    emailPassword: true,
    providers: [],
    accessEmail: null,
    emailConfigured: false,
    signUp: "invitation" as const,
    emailVerification: false,
  };
  const quiet = { signedIn: false, errorCode: null };

  it("offers Sign up only where anyone may sign up, and not before the methods load", () => {
    expect(signInPageParts(undefined, quiet).signUp).toBe(false);
    expect(signInPageParts(base, quiet).signUp).toBe(false);
    expect(signInPageParts({ ...base, signUp: "open" }, quiet).signUp).toBe(
      true,
    );
  });

  it("shows Continue with <label> for Access until Access has named the person", () => {
    const sso = {
      ...base,
      providers: [{ id: "cloudflare-access", label: "Company SSO" }],
    };
    expect(signInPageParts(sso, quiet).buttons).toEqual(sso.providers);
    expect(
      signInPageParts({ ...sso, accessEmail: "alice@acme.com" }, quiet).buttons,
    ).toEqual([]);
    expect(signInPageParts(base, quiet).buttons).toEqual([]);
  });

  it("shows one button per provider, in order, and keeps the sign-in providers behind the outer ring", () => {
    const providers = [
      { id: "cloudflare-access", label: "Company SSO" },
      { id: "google", label: "Google" },
      { id: "oidc", label: "Okta" },
    ];
    expect(
      signInPageParts({ ...base, providers }, quiet).buttons.map(
        (provider) => provider.label,
      ),
    ).toEqual(["Company SSO", "Google", "Okta"]);
    // Access named the person: its own button goes, Google and Okta stay
    // (a provider sign-in there is still only the Access person's).
    expect(
      signInPageParts(
        { ...base, providers, accessEmail: "alice@acme.com" },
        quiet,
      ).buttons.map((provider) => provider.id),
    ).toEqual(["google", "oidc"]);
  });

  it("names who Access says is here, unless a red alert already does", () => {
    const named = { ...base, accessEmail: "alice@acme.com" };
    expect(signInPageParts(named, quiet).accessNote).toBe(true);
    expect(
      signInPageParts(named, {
        ...quiet,
        errorCode: "ACCESS_NOT_INVITED",
      }).accessNote,
    ).toBe(false);
    expect(
      signInPageParts(named, {
        ...quiet,
        errorCode: "ACCESS_EMAIL_MISMATCH",
      }).accessNote,
    ).toBe(false);
    expect(
      signInPageParts(named, { ...quiet, signedIn: true }).accessNote,
    ).toBe(false);
    expect(signInPageParts(base, quiet).accessNote).toBe(false);
  });

  it("offers Sign out of Access on a red Access alert behind the outer ring", () => {
    const named = { ...base, accessEmail: "alice@acme.com" };
    expect(signInPageParts(named, quiet).accessSignOut).toBe(false);
    expect(
      signInPageParts(named, {
        ...quiet,
        errorCode: "ACCESS_NOT_INVITED",
      }).accessSignOut,
    ).toBe(true);
    // The mismatch code only comes from the outer ring, even if the methods
    // couldn't load.
    expect(
      signInPageParts(base, {
        ...quiet,
        errorCode: "ACCESS_EMAIL_MISMATCH",
      }).accessSignOut,
    ).toBe(true);
    // An OIDC-only gateway has no Access sign-out on this host.
    expect(
      signInPageParts(base, { ...quiet, errorCode: "ACCESS_NOT_INVITED" })
        .accessSignOut,
    ).toBe(false);
  });
});
