import { describe, expect, it } from "vitest";
import { normalizeIssuer, readSignInProviders } from "./config";
import { microsoftEmailVerified } from "./providers";

const production = { allowLoopback: false };
const dev = { allowLoopback: true };

describe("readSignInProviders", () => {
  it("turns nothing on when nothing is set, and reports no problem", () => {
    const config = readSignInProviders({}, production);
    expect(config.providers).toEqual([]);
    expect(config.problems).toEqual([]);
    expect(config.states.map((state) => state.status)).toEqual([
      "off",
      "off",
      "off",
      "off",
      "off",
      "off",
    ]);
  });

  it("turns a provider on with its client id and secret, in catalog order", () => {
    const config = readSignInProviders(
      {
        GITHUB_SIGNIN_CLIENT_ID: " gh-id ",
        GITHUB_SIGNIN_CLIENT_SECRET: "gh-secret",
        GOOGLE_SIGNIN_CLIENT_ID: "g-id",
        GOOGLE_SIGNIN_CLIENT_SECRET: "g-secret",
      },
      production,
    );
    expect(config.providers).toEqual([
      {
        id: "google",
        label: "Google",
        clientId: "g-id",
        clientSecret: "g-secret",
      },
      {
        id: "github",
        label: "GitHub",
        clientId: "gh-id",
        clientSecret: "gh-secret",
      },
    ]);
    expect(config.problems).toEqual([]);
  });

  it("leaves a half-set provider off and says what is missing", () => {
    const config = readSignInProviders(
      { GOOGLE_SIGNIN_CLIENT_ID: "g-id" },
      production,
    );
    expect(config.providers).toEqual([]);
    expect(config.problems).toEqual([
      "Sign in with Google needs GOOGLE_SIGNIN_CLIENT_SECRET; it is off.",
    ]);
    expect(config.states.find((state) => state.id === "google")).toEqual({
      id: "google",
      status: "incomplete",
      missing: ["GOOGLE_SIGNIN_CLIENT_SECRET"],
      set: ["GOOGLE_SIGNIN_CLIENT_ID"],
    });
  });

  it("treats a blank value as unset", () => {
    const config = readSignInProviders(
      { GOOGLE_SIGNIN_CLIENT_ID: "g-id", GOOGLE_SIGNIN_CLIENT_SECRET: "  " },
      production,
    );
    expect(config.providers).toEqual([]);
    expect(config.states.find((state) => state.id === "google")?.status).toBe(
      "incomplete",
    );
  });

  describe("the OIDC issuer", () => {
    const base = {
      OIDC_SIGNIN_CLIENT_ID: "acme",
      OIDC_SIGNIN_CLIENT_SECRET: "secret",
    };

    it("is kept without a trailing slash, with the label and its default", () => {
      const config = readSignInProviders(
        { ...base, OIDC_SIGNIN_ISSUER: "https://sso.acme.com/oauth2/default/" },
        production,
      );
      expect(config.providers).toEqual([
        {
          id: "oidc",
          label: "SSO",
          clientId: "acme",
          clientSecret: "secret",
          issuer: "https://sso.acme.com/oauth2/default",
        },
      ]);
      const labelled = readSignInProviders(
        {
          ...base,
          OIDC_SIGNIN_ISSUER: "https://sso.acme.com",
          OIDC_SIGNIN_LABEL: "Acme Okta",
        },
        production,
      );
      expect(labelled.providers[0]?.label).toBe("Acme Okta");
    });

    it.each([
      "http://sso.acme.com",
      "https://user:pw@sso.acme.com",
      "https://sso.acme.com/?x=1",
      "https://sso.acme.com/#frag",
      "sso.acme.com",
    ])("refuses %s and turns SSO off", (issuer) => {
      const config = readSignInProviders(
        { ...base, OIDC_SIGNIN_ISSUER: issuer },
        production,
      );
      expect(config.providers).toEqual([]);
      expect(config.problems[0]).toContain(
        "OIDC_SIGNIN_ISSUER must be an https URL",
      );
      expect(config.states.find((state) => state.id === "oidc")?.status).toBe(
        "incomplete",
      );
    });

    it("accepts a loopback issuer only in dev builds", () => {
      const settings = { ...base, OIDC_SIGNIN_ISSUER: "http://localhost:9000" };
      expect(readSignInProviders(settings, production).providers).toEqual([]);
      expect(readSignInProviders(settings, dev).providers[0]?.issuer).toBe(
        "http://localhost:9000",
      );
    });

    it("caps the label", () => {
      expect(normalizeIssuer("https://sso.acme.com/", production)).toBe(
        "https://sso.acme.com",
      );
      const config = readSignInProviders(
        {
          ...base,
          OIDC_SIGNIN_ISSUER: "https://sso.acme.com",
          OIDC_SIGNIN_LABEL: "x".repeat(80),
        },
        production,
      );
      expect(config.providers[0]?.label).toHaveLength(40);
    });
  });

  describe("the Microsoft tenant", () => {
    const base = {
      MICROSOFT_SIGNIN_CLIENT_ID: "ms-id",
      MICROSOFT_SIGNIN_CLIENT_SECRET: "ms-secret",
    };

    it("defaults to common and takes a tenant id or one of the words", () => {
      expect(readSignInProviders(base, production).providers[0]?.tenant).toBe(
        "common",
      );
      expect(
        readSignInProviders(
          { ...base, MICROSOFT_SIGNIN_TENANT: "Organizations" },
          production,
        ).providers[0]?.tenant,
      ).toBe("organizations");
      expect(
        readSignInProviders(
          {
            ...base,
            MICROSOFT_SIGNIN_TENANT: "72F988BF-86F1-41AF-91AB-2D7CD011DB47",
          },
          production,
        ).providers[0]?.tenant,
      ).toBe("72f988bf-86f1-41af-91ab-2d7cd011db47");
    });

    it("refuses anything else and turns Microsoft off", () => {
      const config = readSignInProviders(
        { ...base, MICROSOFT_SIGNIN_TENANT: "acme.onmicrosoft.com" },
        production,
      );
      expect(config.providers).toEqual([]);
      expect(config.problems[0]).toContain("MICROSOFT_SIGNIN_TENANT must be");
    });
  });
});

describe("microsoftEmailVerified", () => {
  const consumer = "9188040d-6c67-4c5b-b112-36a304b66dad";
  const acme = "72f988bf-86f1-41af-91ab-2d7cd011db47";

  it("trusts the pinned tenant's own directory, and only it", () => {
    expect(
      microsoftEmailVerified({ email: "a@acme.com", tid: acme }, acme),
    ).toBe(true);
    expect(
      microsoftEmailVerified({ email: "a@acme.com", tid: "other" }, acme),
    ).toBe(false);
  });

  it("on the multi-tenant endpoints needs the token's word for the address", () => {
    const email = "a@acme.com";
    expect(microsoftEmailVerified({ email, tid: "t" }, "common")).toBe(false);
    expect(
      microsoftEmailVerified({ email, tid: "t", xms_edov: true }, "common"),
    ).toBe(true);
    expect(
      microsoftEmailVerified(
        { email, tid: "t", email_verified: true },
        "common",
      ),
    ).toBe(true);
    expect(
      microsoftEmailVerified(
        { email, tid: "t", verified_primary_email: [email] },
        "common",
      ),
    ).toBe(true);
    expect(
      microsoftEmailVerified(
        { email, tid: "t", verified_primary_email: ["b@acme.com"] },
        "organizations",
      ),
    ).toBe(false);
    expect(microsoftEmailVerified({ email, tid: consumer }, "common")).toBe(
      true,
    );
  });

  it("never counts a token without an email", () => {
    expect(microsoftEmailVerified({ tid: acme, xms_edov: true }, acme)).toBe(
      false,
    );
  });
});
