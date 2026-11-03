/**
 * The one set of scope rules (./oauthScopes.ts), on made-up flows: each
 * rule driven by a spec field alone. The built-in providers' own cases
 * are in oauthBuiltIns.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { OAuthFlow } from "./capabilities";
import {
  canonicalScope,
  canonicalScopes,
  expandScope,
  grantedScopes,
  joinScopes,
  jsonObject,
  missingScopes,
  requestedScopes,
  scopeExcess,
} from "./oauthScopes";

type Rules = Pick<
  OAuthFlow,
  "scopeSeparator" | "scopePrefix" | "identityScopes" | "tolerated"
>;

/** A provider with a prefix, identity scopes and a tolerated one. */
const PREFIXED: Rules = {
  scopeSeparator: "space",
  scopePrefix: "https://api.example.com/auth/",
  identityScopes: ["openid", "email"],
  tolerated: ["profile"],
};
/** A provider that spells scopes as written, comma-separated, with none of its own. */
const PLAIN: Rules = {
  scopeSeparator: "comma",
  identityScopes: [],
  tolerated: [],
};

describe("expandScope", () => {
  it("joins a short scope onto the prefix and leaves a full one, or the spec's own, as written", () => {
    expect(expandScope(PREFIXED, "mail.read")).toBe(
      "https://api.example.com/auth/mail.read",
    );
    expect(expandScope(PREFIXED, "https://other.example/scope")).toBe(
      "https://other.example/scope",
    );
    expect(expandScope(PREFIXED, "openid")).toBe("openid");
    expect(expandScope(PREFIXED, "profile")).toBe("profile");
    expect(expandScope(PLAIN, "repo")).toBe("repo");
  });
});

describe("canonicalScope", () => {
  it("decodes, lower-cases and takes the prefix off", () => {
    expect(
      canonicalScope(PREFIXED, "https://api.example.com/auth/Mail.Read"),
    ).toBe("mail.read");
    expect(
      canonicalScope(
        PREFIXED,
        "https%3A%2F%2Fapi.example.com%2Fauth%2Fmail.read",
      ),
    ).toBe("mail.read");
    expect(canonicalScope(PREFIXED, " Mail.Read ")).toBe("mail.read");
    expect(canonicalScope(PLAIN, "Read:User")).toBe("read:user");
  });

  it("keeps a malformed escape as written, so it matches nothing asked", () => {
    expect(canonicalScope(PLAIN, "repo%zz")).toBe("repo%zz");
  });

  it("dedupes a list in canonical form, order kept", () => {
    expect(
      canonicalScopes(PREFIXED, [
        "mail.read",
        "https://api.example.com/auth/mail.read",
        "Mail.Send",
        "",
      ]),
    ).toEqual(["mail.read", "mail.send"]);
  });
});

describe("requestedScopes and joinScopes", () => {
  it("asks for the app's scopes in the provider's spelling, then the identity scopes, each once", () => {
    expect(requestedScopes(PREFIXED, ["mail.read", "email"])).toEqual([
      "https://api.example.com/auth/mail.read",
      "email",
      "openid",
    ]);
    expect(requestedScopes(PLAIN, [])).toEqual([]);
  });

  it("joins them with the spec's separator", () => {
    expect(joinScopes(PREFIXED, ["a", "b"])).toBe("a b");
    expect(joinScopes(PLAIN, ["a", "b"])).toBe("a,b");
  });
});

describe("grantedScopes", () => {
  const requested = requestedScopes(PREFIXED, ["mail.read"]);

  it("reads the answer's scope field with the separator, canonical", () => {
    expect(
      grantedScopes(
        PREFIXED,
        { scope: "https://api.example.com/auth/mail.read openid  email" },
        requested,
      ),
    ).toEqual(["mail.read", "openid", "email"]);
    // A comma provider's answer may also put spaces after the commas.
    expect(
      grantedScopes(PLAIN, { scope: "repo, read:user,gist" }, ["repo"]),
    ).toEqual(["repo", "read:user", "gist"]);
    // A whole field percent-encoded.
    expect(grantedScopes(PLAIN, { scope: "repo%2Cgist" }, ["repo"])).toEqual([
      "repo",
      "gist",
    ]);
  });

  it("takes an answer with no scope field as granted exactly as asked", () => {
    expect(grantedScopes(PREFIXED, { access_token: "t" }, requested)).toEqual([
      "mail.read",
      "openid",
      "email",
    ]);
  });

  it("refuses a scope field that isn't a string, or doesn't decode", () => {
    expect(
      grantedScopes(PREFIXED, { scope: ["mail.read"] }, requested),
    ).toBeNull();
    expect(grantedScopes(PREFIXED, { scope: null }, requested)).toBeNull();
    expect(grantedScopes(PLAIN, { scope: "repo%zz" }, ["repo"])).toBeNull();
  });

  it("reads an empty scope field as nothing granted", () => {
    expect(grantedScopes(PLAIN, { scope: "" }, ["repo"])).toEqual([]);
  });
});

describe("scopeExcess (the mint check)", () => {
  const requested = requestedScopes(PREFIXED, ["mail.read"]);

  it("is empty within what was asked, the identity and tolerated scopes included", () => {
    expect(
      scopeExcess(
        PREFIXED,
        ["mail.read", "openid", "email", "profile"],
        requested,
      ),
    ).toEqual([]);
    expect(scopeExcess(PREFIXED, [], requested)).toEqual([]);
  });

  it("names every scope beyond them", () => {
    expect(
      scopeExcess(PREFIXED, ["mail.read", "mail.send", "drive"], requested),
    ).toEqual(["mail.send", "drive"]);
    expect(scopeExcess(PLAIN, ["repo", "admin:org"], ["repo"])).toEqual([
      "admin:org",
    ]);
  });
});

describe("missingScopes", () => {
  it("names the declared scopes a connection doesn't hold, as the app wrote them", () => {
    expect(
      missingScopes(PREFIXED, ["mail.read"], ["Mail.Read", "mail.send"]),
    ).toEqual(["mail.send"]);
    expect(
      missingScopes(
        PREFIXED,
        ["https://api.example.com/auth/mail.read"],
        ["mail.read"],
      ),
    ).toEqual([]);
    expect(missingScopes(PLAIN, [], [])).toEqual([]);
  });
});

describe("jsonObject", () => {
  it("is a JSON object or null", () => {
    expect(jsonObject('{"access_token":"t"}')).toEqual({ access_token: "t" });
    expect(jsonObject("[1]")).toBeNull();
    expect(jsonObject('"t"')).toBeNull();
    expect(jsonObject("null")).toBeNull();
    expect(jsonObject("access_token=t")).toBeNull();
  });
});
