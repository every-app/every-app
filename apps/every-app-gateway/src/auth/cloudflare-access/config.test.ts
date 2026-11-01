import { describe, expect, it } from "vitest";
import {
  isAccessSignInConfigured,
  readAccessConfig,
  type AccessEnv,
} from "./config";

const CLIENT_ID = "9f2c1e0d7b6a5f4e3d2c1b0a9f8e7d6c";
const ISSUER = `https://acme.cloudflareaccess.com/cdn-cgi/access/sso/oidc/${CLIENT_ID}`;
const AUD = "4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2";

const OIDC: AccessEnv = {
  CLOUDFLARE_ACCESS_OIDC_ISSUER: ISSUER,
  CLOUDFLARE_ACCESS_OIDC_CLIENT_ID: CLIENT_ID,
  CLOUDFLARE_ACCESS_OIDC_CLIENT_SECRET: "secret",
};
const OUTER_RING: AccessEnv = {
  CLOUDFLARE_ACCESS_TEAM_DOMAIN: "acme.cloudflareaccess.com",
  CLOUDFLARE_ACCESS_AUD: AUD,
};

const production = { allowLoopback: false };

describe("readAccessConfig", () => {
  it("is all off with nothing set: passwords only", () => {
    expect(readAccessConfig({}, production)).toEqual({
      oidc: null,
      outerRing: null,
      autoJoinDomains: [],
      passwordSignIn: true,
      idpIds: [],
      problems: [],
    });
    expect(isAccessSignInConfigured(readAccessConfig({}, production))).toBe(
      false,
    );
  });

  describe("OIDC sign-in", () => {
    it("derives the endpoints from the issuer, with a default label", () => {
      const { oidc, problems } = readAccessConfig(
        { ...OIDC, CLOUDFLARE_ACCESS_OIDC_ISSUER: `${ISSUER}/` },
        production,
      );
      expect(problems).toEqual([]);
      expect(oidc).toEqual({
        issuer: ISSUER,
        clientId: CLIENT_ID,
        clientSecret: "secret",
        label: "Cloudflare Access",
        authorizationEndpoint: `${ISSUER}/authorization`,
        tokenEndpoint: `${ISSUER}/token`,
        idpIds: [],
        jwksUrl: `${ISSUER}/jwks`,
      });
    });

    it("takes the button label from CLOUDFLARE_ACCESS_OIDC_LABEL", () => {
      const { oidc } = readAccessConfig(
        { ...OIDC, CLOUDFLARE_ACCESS_OIDC_LABEL: "  Company SSO " },
        production,
      );
      expect(oidc?.label).toBe("Company SSO");
    });

    it("stays off without all three settings", () => {
      for (const missing of Object.keys(OIDC) as (keyof AccessEnv)[]) {
        const config = readAccessConfig(
          { ...OIDC, [missing]: undefined },
          production,
        );
        expect(config.oidc).toBeNull();
        expect(config.problems).toHaveLength(1);
      }
    });

    it("takes only an https issuer on a cloudflareaccess.com team domain", () => {
      for (const issuer of [
        `http://acme.cloudflareaccess.com/cdn-cgi/access/sso/oidc/${CLIENT_ID}`,
        `https://acme.cloudflareaccess.com.evil.example/cdn-cgi/access/sso/oidc/${CLIENT_ID}`,
        `https://evil.example/cdn-cgi/access/sso/oidc/${CLIENT_ID}`,
        `https://user:pass@acme.cloudflareaccess.com/cdn-cgi/access/sso/oidc/${CLIENT_ID}`,
        `${ISSUER}?x=1`,
        "not a url",
      ]) {
        const config = readAccessConfig(
          { ...OIDC, CLOUDFLARE_ACCESS_OIDC_ISSUER: issuer },
          production,
        );
        expect(config.oidc, issuer).toBeNull();
      }
    });

    it("refuses an issuer that belongs to another client id", () => {
      const config = readAccessConfig(
        {
          ...OIDC,
          CLOUDFLARE_ACCESS_OIDC_ISSUER:
            "https://acme.cloudflareaccess.com/cdn-cgi/access/sso/oidc/another-client",
        },
        production,
      );
      expect(config.oidc).toBeNull();
      expect(config.problems[0]).toContain("isn't the issuer");
    });

    it("accepts a loopback mock IdP only in local development", () => {
      const local = {
        ...OIDC,
        CLOUDFLARE_ACCESS_OIDC_ISSUER: "http://localhost:19400/oidc",
      };
      expect(readAccessConfig(local, production).oidc).toBeNull();
      expect(
        readAccessConfig(local, { allowLoopback: true }).oidc?.tokenEndpoint,
      ).toBe("http://localhost:19400/oidc/token");
    });
  });

  describe("the outer ring", () => {
    it("reads the team domain (with or without https://) and AUD tags", () => {
      for (const teamDomain of [
        "acme.cloudflareaccess.com",
        "https://acme.cloudflareaccess.com",
        "https://acme.cloudflareaccess.com/",
      ]) {
        const { outerRing, problems } = readAccessConfig(
          {
            CLOUDFLARE_ACCESS_TEAM_DOMAIN: teamDomain,
            CLOUDFLARE_ACCESS_AUD: ` ${AUD}, other-aud ${AUD}`,
          },
          production,
        );
        expect(problems).toEqual([]);
        expect(outerRing).toEqual({
          issuer: "https://acme.cloudflareaccess.com",
          signInAudiences: [AUD, "other-aud"],
          audiences: [AUD, "other-aud"],
          certsUrl: "https://acme.cloudflareaccess.com/cdn-cgi/access/certs",
          autoJoinEveryone: false,
          idpIds: [],
        });
      }
    });

    it("lets only the gateway application's AUD sign people in; the apps' only vouches", () => {
      const { outerRing, problems } = readAccessConfig(
        { ...OUTER_RING, CLOUDFLARE_ACCESS_APPS_AUD: `apps-aud, ${AUD}` },
        production,
      );
      expect(problems).toEqual([]);
      expect(outerRing).toMatchObject({
        signInAudiences: [AUD],
        audiences: [AUD, "apps-aud"],
      });

      // Malformed: the outer ring is off rather than half set up.
      const malformed = readAccessConfig(
        { ...OUTER_RING, CLOUDFLARE_ACCESS_APPS_AUD: "not an aud!" },
        production,
      );
      expect(malformed.outerRing).toBeNull();
      expect(malformed.problems[0]).toContain("CLOUDFLARE_ACCESS_APPS_AUD");

      // Without the outer ring it does nothing, and says so.
      const alone = readAccessConfig(
        { CLOUDFLARE_ACCESS_APPS_AUD: "apps-aud" },
        production,
      );
      expect(alone.outerRing).toBeNull();
      expect(alone.problems[0]).toContain("does nothing");
    });

    it("needs both settings, and a real team domain", () => {
      expect(
        readAccessConfig(
          { CLOUDFLARE_ACCESS_TEAM_DOMAIN: "acme.cloudflareaccess.com" },
          production,
        ).outerRing,
      ).toBeNull();
      expect(
        readAccessConfig({ CLOUDFLARE_ACCESS_AUD: AUD }, production).outerRing,
      ).toBeNull();
      expect(
        readAccessConfig(
          { ...OUTER_RING, CLOUDFLARE_ACCESS_AUD: " , " },
          production,
        ).outerRing,
      ).toBeNull();
      for (const teamDomain of [
        "acme.example.com",
        "https://acme.cloudflareaccess.com/cdn-cgi",
        "http://acme.cloudflareaccess.com",
      ]) {
        expect(
          readAccessConfig(
            { ...OUTER_RING, CLOUDFLARE_ACCESS_TEAM_DOMAIN: teamDomain },
            production,
          ).outerRing,
          teamDomain,
        ).toBeNull();
      }
    });

    it("lets everyone it admits join only when set to exactly 'everyone'", () => {
      expect(
        readAccessConfig(
          { ...OUTER_RING, CLOUDFLARE_ACCESS_OUTER_RING_AUTO_JOIN: "Everyone" },
          production,
        ).outerRing?.autoJoinEveryone,
      ).toBe(true);
      const typo = readAccessConfig(
        { ...OUTER_RING, CLOUDFLARE_ACCESS_OUTER_RING_AUTO_JOIN: "true" },
        production,
      );
      expect(typo.outerRing?.autoJoinEveryone).toBe(false);
      expect(typo.problems).toHaveLength(1);
    });
  });

  it("reads the identity-provider allowlist onto both sign-ins, skipping anything that isn't an id", () => {
    const config = readAccessConfig(
      {
        CLOUDFLARE_ACCESS_TEAM_DOMAIN: "acme.cloudflareaccess.com",
        CLOUDFLARE_ACCESS_AUD: AUD,
        CLOUDFLARE_ACCESS_IDP_IDS:
          " 0f1e2d3c-aaaa-bbbb-cccc-000000000001, not/an/id!\n0f1e2d3c-aaaa-bbbb-cccc-000000000001 second-id",
      },
      production,
    );
    expect(config.idpIds).toEqual([
      "0f1e2d3c-aaaa-bbbb-cccc-000000000001",
      "second-id",
    ]);
    expect(config.outerRing?.idpIds).toEqual(config.idpIds);
    expect(config.problems).toEqual([
      expect.stringContaining('"not/an/id!" isn\'t an identity provider id'),
    ]);
    expect(readAccessConfig({}, production).idpIds).toEqual([]);
  });

  it("reads auto-join email domains, skipping anything else", () => {
    const config = readAccessConfig(
      {
        CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS:
          "Acme.com, @acme.io acme.com *  bad_domain",
      },
      production,
    );
    expect(config.autoJoinDomains).toEqual(["acme.com", "acme.io"]);
    expect(config.problems).toHaveLength(2);
  });

  describe("EMAIL_PASSWORD_SIGN_IN", () => {
    it("turns password sign-in off only with Access sign-in configured", () => {
      for (const access of [OIDC, OUTER_RING]) {
        expect(
          readAccessConfig(
            { ...access, EMAIL_PASSWORD_SIGN_IN: "false" },
            production,
          ).passwordSignIn,
        ).toBe(false);
      }

      const alone = readAccessConfig(
        { EMAIL_PASSWORD_SIGN_IN: "false" },
        production,
      );
      expect(alone.passwordSignIn).toBe(true);
      expect(alone.problems[0]).toContain("lock everyone out");

      // A misconfigured Access sign-in doesn't count either.
      expect(
        readAccessConfig(
          {
            ...OIDC,
            CLOUDFLARE_ACCESS_OIDC_ISSUER: "https://evil.example/oidc",
            EMAIL_PASSWORD_SIGN_IN: "false",
          },
          production,
        ).passwordSignIn,
      ).toBe(true);
    });

    it("keeps passwords on for an unrecognized value", () => {
      const config = readAccessConfig(
        { ...OIDC, EMAIL_PASSWORD_SIGN_IN: "disabled" },
        production,
      );
      expect(config.passwordSignIn).toBe(true);
      expect(config.problems).toHaveLength(1);
      expect(
        readAccessConfig(
          { ...OIDC, EMAIL_PASSWORD_SIGN_IN: "true" },
          production,
        ).passwordSignIn,
      ).toBe(true);
    });
  });
});
