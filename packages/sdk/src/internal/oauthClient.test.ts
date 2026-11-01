import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  type OAuthClientCapability,
  type OAuthTokenEndpoint,
} from "./capabilities";
import {
  injectClientCredentials,
  oauthClientCredentials,
  requestedGrantType,
  tokenGrantType,
  type TokenRequest,
  USER_BOUND_GRANT_TYPES,
} from "./oauthClient";

const CLIENT = { clientId: "gateway-id", clientSecret: "gateway-secret" };
const FORM = "application/x-www-form-urlencoded";
const GOOGLE: OAuthClientCapability = CAPABILITIES["google-workspace"];
/** A client that takes HTTP Basic, as a registered one may (Reddit's preset). */
const BASIC: OAuthTokenEndpoint = {
  host: "www.reddit.com",
  path: "/api/v1/access_token",
  methods: ["POST"],
  inject: "basic",
};
/** A client without a scope policy, the whole client the grant. */
const PLAIN: OAuthClientCapability = {
  mode: "oauth_client",
  label: "Plain",
  secrets: { clientId: "PLAIN_CLIENT_ID", clientSecret: "PLAIN_CLIENT_SECRET" },
  token: [
    {
      host: "plain.example",
      path: "/token",
      methods: ["POST"],
      inject: "form",
    },
  ],
  access: ["write"],
  console: "https://plain.example/apps",
  authorize: { url: "https://plain.example/authorize", scopes: ["read"] },
  api: ["api.plain.example"],
};

function endpoint(
  capability: OAuthClientCapability,
  index = 0,
): OAuthTokenEndpoint {
  return capability.token[index]!;
}

function request(
  url: string,
  body: string | null,
  headers: Record<string, string> = {},
): TokenRequest {
  return { url: new URL(url), headers: new Headers(headers), body };
}

function injected(
  ...args: Parameters<typeof injectClientCredentials>
): TokenRequest {
  const result = injectClientCredentials(...args);
  if (!result.ok) throw new Error(result.problem);
  return result;
}

/** Everything that reaches the provider, as one string to search. */
function wire({ url, headers, body }: TokenRequest): string {
  return [url.toString(), ...headers.entries(), body ?? ""].join("\n");
}

describe("injectClientCredentials", () => {
  it("form: sets the gateway's client in the body over whatever the app sent", () => {
    const sent = request(
      "https://oauth2.googleapis.com/token?client_secret=app-secret-q",
      "grant_type=authorization_code&code=c&client_id=app-id&client_secret=app-secret&Client_Secret=app-secret-2&client%5Fsecret=app-secret-3&redirect_uri=https%3A%2F%2Fcrm.example.com%2Fcb",
      {
        "content-type": `${FORM}; charset=utf-8`,
        "content-length": "999",
        authorization: "Basic app",
      },
    );
    const out = injected(sent, endpoint(GOOGLE), CLIENT);

    expect(wire(out)).not.toMatch(/app-secret|app-id|Basic app/);
    const params = new URLSearchParams(out.body!);
    expect(params.getAll("client_id")).toEqual(["gateway-id"]);
    expect(params.getAll("client_secret")).toEqual(["gateway-secret"]);
    expect(params.get("code")).toBe("c");
    expect(params.get("redirect_uri")).toBe("https://crm.example.com/cb");
    expect(out.headers.get("content-length")).toBeNull();
    expect(out.headers.get("authorization")).toBeNull();
    expect(out.url.search).toBe("");
    // The input is left as it was.
    expect(sent.body).toContain("app-secret");
  });

  it("form: makes the body when the app sent none", () => {
    const out = injected(
      request("https://oauth2.googleapis.com/token", null),
      endpoint(GOOGLE),
      CLIENT,
    );
    expect(out.body).toBe("client_id=gateway-id&client_secret=gateway-secret");
    expect(out.headers.get("content-type")).toBe(FORM);
  });

  it("basic: sets HTTP Basic and drops any client from the body and query", () => {
    const out = injected(
      request(
        "https://www.reddit.com/api/v1/access_token?client_secret=app-secret-q",
        "grant_type=refresh_token&refresh_token=r&client_secret=app-secret",
        { "content-type": FORM, authorization: "Basic app" },
      ),
      BASIC,
      CLIENT,
    );
    expect(out.headers.get("authorization")).toBe(
      `Basic ${btoa("gateway-id:gateway-secret")}`,
    );
    expect(out.body).toBe("grant_type=refresh_token&refresh_token=r");
    expect(wire(out)).not.toMatch(/app-secret|Basic app/);
    // HTTP Basic is base64 of the UTF-8 bytes.
    const unicode = injected(
      request("https://www.reddit.com/api/v1/access_token", null),
      BASIC,
      { clientId: "id", clientSecret: "sécret" },
    );
    expect(unicode.headers.get("authorization")).toBe(
      `Basic ${Buffer.from("id:sécret").toString("base64")}`,
    );
    expect(unicode.body).toBeNull();
  });

  it("leaves a query without a client byte for byte", () => {
    const url = "https://oauth2.googleapis.com/token?x=a%20b&y";
    const out = injected(request(url, null), endpoint(GOOGLE), CLIENT);
    expect(out.url.toString()).toBe(url);
  });

  it("puts the id alone on for a public client", () => {
    const out = injected(
      request("https://oauth2.googleapis.com/token", "code=c", {
        "content-type": FORM,
      }),
      endpoint(GOOGLE),
      { clientId: "public-id" },
    );
    expect(out.body).toBe("code=c&client_id=public-id");
  });

  it.each<[string, OAuthTokenEndpoint, string, string, RegExp]>([
    [
      "a JSON body to a form endpoint",
      endpoint(GOOGLE),
      "application/json",
      '{"code":"c"}',
      /form-encoded/,
    ],
    [
      "a JSON body to a Basic endpoint",
      BASIC,
      "application/json",
      '{"client_secret":"app-secret"}',
      /form-encoded/,
    ],
    [
      "a multipart body",
      BASIC,
      "multipart/form-data; boundary=x",
      '--x\r\nContent-Disposition: form-data; name="client_secret"\r\n\r\napp-secret\r\n--x--',
      /form-encoded/,
    ],
    [
      "a body without a type",
      endpoint(GOOGLE),
      "",
      "client_secret=app-secret",
      /form-encoded/,
    ],
  ])("refuses %s", (_case, rule, type, body, problem) => {
    const result = injectClientCredentials(
      request(
        "https://example.com/token",
        body,
        type ? { "content-type": type } : {},
      ),
      rule,
      CLIENT,
    );
    expect(result).toEqual({
      ok: false,
      problem: expect.stringMatching(problem),
    });
  });
});

describe("tokenGrantType", () => {
  it.each<[string, TokenRequest, string | null]>([
    [
      "a form body",
      request(
        "https://x.example/t",
        "grant_type=refresh_token&refresh_token=r",
        {
          "content-type": FORM,
        },
      ),
      "refresh_token",
    ],
    [
      "the query string",
      request("https://x.example/t?grant_type=authorization_code&code=c", null),
      "authorization_code",
    ],
    [
      "a value it doesn't know (a token, say)",
      request("https://x.example/t?grant_type=EAAB-user-token", null),
      "other",
    ],
    [
      "no grant type (Slack's code exchange)",
      request("https://x.example/t?code=c", null),
      null,
    ],
  ])("reads %s", (_case, sent, grantType) => {
    expect(tokenGrantType(sent)).toBe(grantType);
  });
});

describe("oauthClientCredentials", () => {
  it("needs the id and the secret", () => {
    expect(oauthClientCredentials(PLAIN, {})).toBeNull();
    expect(oauthClientCredentials(PLAIN, { PLAIN_CLIENT_ID: "id" })).toBeNull();
    expect(
      oauthClientCredentials(PLAIN, {
        PLAIN_CLIENT_ID: " id ",
        PLAIN_CLIENT_SECRET: " secret ",
      }),
    ).toEqual({ clientId: "id", clientSecret: "secret" });
  });

  it("needs the id alone for a public client", () => {
    const pub: OAuthClientCapability = {
      ...PLAIN,
      secrets: { clientId: "PLAIN_CLIENT_ID" },
    };
    expect(oauthClientCredentials(pub, { PLAIN_CLIENT_ID: "id" })).toEqual({
      clientId: "id",
    });
  });
});

describe("requestedGrantType and the grants the gateway completes", () => {
  it("reads the grant as sent, and knows which ones end in a user's own tokens", () => {
    expect(
      requestedGrantType(
        request("https://x.example/t?grant_type=client_credentials", null),
      ),
    ).toBe("client_credentials");
    expect(
      requestedGrantType(
        request("https://x.example/t", "grant_type=password&username=u", {
          "content-type": FORM,
        }),
      ),
    ).toBe("password");
    expect(
      requestedGrantType(request("https://x.example/t?code=c", null)),
    ).toBeNull();
    for (const grant of ["authorization_code", "refresh_token"]) {
      expect(USER_BOUND_GRANT_TYPES.has(grant)).toBe(true);
    }
    for (const grant of ["client_credentials", "fb_exchange_token"]) {
      expect(USER_BOUND_GRANT_TYPES.has(grant)).toBe(false);
    }
  });
});
