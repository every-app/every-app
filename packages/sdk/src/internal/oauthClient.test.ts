import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  type OAuthClientCapability,
  type OAuthTokenEndpoint,
} from "./capabilities";
import {
  injectClientCredentials,
  oauthClientCredentials,
  tokenGrantType,
  type TokenRequest,
} from "./oauthClient";

const CLIENT = { clientId: "gateway-id", clientSecret: "gateway-secret" };
const FORM = "application/x-www-form-urlencoded";

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
      "https://www.linkedin.com/oauth/v2/accessToken?client_secret=app-secret-q",
      "grant_type=authorization_code&code=c&client_id=app-id&client_secret=app-secret&Client_Secret=app-secret-2&client%5Fsecret=app-secret-3&redirect_uri=https%3A%2F%2Fpostiz.example.com%2Fcb",
      {
        "content-type": `${FORM}; charset=utf-8`,
        "content-length": "999",
        authorization: "Basic app",
      },
    );
    const out = injected(sent, endpoint(CAPABILITIES.linkedin), CLIENT);

    expect(wire(out)).not.toMatch(/app-secret|app-id|Basic app/);
    const params = new URLSearchParams(out.body!);
    expect(params.getAll("client_id")).toEqual(["gateway-id"]);
    expect(params.getAll("client_secret")).toEqual(["gateway-secret"]);
    expect(params.get("code")).toBe("c");
    expect(params.get("redirect_uri")).toBe("https://postiz.example.com/cb");
    expect(out.headers.get("content-length")).toBeNull();
    expect(out.headers.get("authorization")).toBeNull();
    expect(out.url.search).toBe("");
    // The input is left as it was.
    expect(sent.body).toContain("app-secret");
  });

  it("form: makes the body when the app sent none", () => {
    const out = injected(
      request("https://id.kick.com/oauth/token", null),
      endpoint(CAPABILITIES.kick),
      CLIENT,
    );
    expect(out.body).toBe("client_id=gateway-id&client_secret=gateway-secret");
    expect(out.headers.get("content-type")).toBe(FORM);
  });

  it("form: names the id as the rule does (TikTok's client_key)", () => {
    const out = injected(
      request(
        "https://open.tiktokapis.com/v2/oauth/token/",
        "client_key=app-key&client_id=app-id&client_secret=app-secret&grant_type=refresh_token&refresh_token=r",
        { "content-type": FORM },
      ),
      endpoint(CAPABILITIES.tiktok),
      CLIENT,
    );
    const params = new URLSearchParams(out.body!);
    expect(params.getAll("client_key")).toEqual(["gateway-id"]);
    expect(params.get("client_id")).toBeNull();
    expect(params.getAll("client_secret")).toEqual(["gateway-secret"]);
    expect(wire(out)).not.toMatch(/app-/);
  });

  it("basic: sets HTTP Basic and drops any client from the body and query", () => {
    const out = injected(
      request(
        "https://www.reddit.com/api/v1/access_token?client_secret=app-secret-q",
        "grant_type=refresh_token&refresh_token=r&client_secret=app-secret",
        { "content-type": FORM, authorization: "Basic app" },
      ),
      endpoint(CAPABILITIES.reddit),
      CLIENT,
    );
    expect(out.headers.get("authorization")).toBe(
      `Basic ${btoa("gateway-id:gateway-secret")}`,
    );
    expect(out.body).toBe("grant_type=refresh_token&refresh_token=r");
    expect(wire(out)).not.toMatch(/app-secret|Basic app/);
    // HTTP Basic is base64 of the UTF-8 bytes.
    const unicode = injected(
      request("https://discord.com/api/oauth2/token", null),
      endpoint(CAPABILITIES.discord),
      { clientId: "id", clientSecret: "sécret" },
    );
    expect(unicode.headers.get("authorization")).toBe(
      `Basic ${Buffer.from("id:sécret").toString("base64")}`,
    );
    expect(unicode.body).toBeNull();
  });

  it("query: sets the client in the query string, on Meta's versioned path too", () => {
    const out = injected(
      request(
        "https://graph.facebook.com/v25.0/oauth/access_token?client_id=app-id&client_secret=app-secret&code=c&redirect_uri=https%3A%2F%2Fpostiz.example.com%2Fcb",
        null,
      ),
      endpoint(CAPABILITIES.facebook),
      CLIENT,
    );
    expect(out.url.searchParams.getAll("client_id")).toEqual(["gateway-id"]);
    expect(out.url.searchParams.getAll("client_secret")).toEqual([
      "gateway-secret",
    ]);
    expect(out.url.searchParams.get("code")).toBe("c");
    expect(out.url.pathname).toBe("/v25.0/oauth/access_token");
    expect(wire(out)).not.toMatch(/app-/);
  });

  it("query: drops a client the app put in the body of a POST", () => {
    const out = injected(
      request(
        "https://dribbble.com/oauth/token?code=c",
        "client_secret=app-secret&code=c",
        { "content-type": FORM },
      ),
      endpoint(CAPABILITIES.dribbble),
      CLIENT,
    );
    expect(out.body).toBe("code=c");
    expect(out.url.searchParams.get("client_secret")).toBe("gateway-secret");
    expect(wire(out)).not.toMatch(/app-secret/);
  });

  it("query: leaves a query without a client byte for byte", () => {
    const url =
      "https://graph.threads.net/access_token?grant_type=th_exchange_token&access_token=a%20b";
    const out = injected(
      request(url, null),
      endpoint(CAPABILITIES.threads, 1),
      { clientId: "gateway-id", clientSecret: "gateway-secret" },
    );
    expect(out.url.toString()).toBe(
      `${url}&client_id=gateway-id&client_secret=gateway-secret`,
    );
  });

  it("json: sets the client in the JSON body, whatever the app sent", () => {
    const out = injected(
      request(
        "https://business-api.tiktok.com/open_api/v1.3/tt_user/oauth2/token/",
        '{"client_id":"app-id","client_secret":"app-secret","CLIENT_SECRET":"app-secret-2","client_secret":"app-secret-3","grant_type":"authorization_code","auth_code":"c","redirect_uri":"https://postiz.example.com/cb/"}',
        { "content-type": "application/json" },
      ),
      endpoint(CAPABILITIES["tiktok-business"]),
      CLIENT,
    );
    expect(JSON.parse(out.body!)).toEqual({
      grant_type: "authorization_code",
      auth_code: "c",
      redirect_uri: "https://postiz.example.com/cb/",
      client_id: "gateway-id",
      client_secret: "gateway-secret",
    });
    expect(wire(out)).not.toMatch(/app-/);
  });

  it("json: makes the body when the app sent none", () => {
    const out = injected(
      request(
        "https://business-api.tiktok.com/open_api/v1.3/tt_user/oauth2/refresh_token/",
        "",
      ),
      endpoint(CAPABILITIES["tiktok-business"], 1),
      CLIENT,
    );
    expect(JSON.parse(out.body!)).toEqual({
      client_id: "gateway-id",
      client_secret: "gateway-secret",
    });
    expect(out.headers.get("content-type")).toBe("application/json");
  });

  it("puts the id alone on for a public client", () => {
    const out = injected(
      request("https://id.kick.com/oauth/token", "code=c", {
        "content-type": FORM,
      }),
      endpoint(CAPABILITIES.kick),
      { clientId: "public-id" },
    );
    expect(out.body).toBe("code=c&client_id=public-id");
  });

  it.each<[string, OAuthTokenEndpoint, string, string, RegExp]>([
    [
      "a JSON body to a form endpoint",
      endpoint(CAPABILITIES.linkedin),
      "application/json",
      '{"code":"c"}',
      /form-encoded/,
    ],
    [
      "a form body to a JSON endpoint",
      endpoint(CAPABILITIES["tiktok-business"]),
      FORM,
      "code=c",
      /JSON body/,
    ],
    [
      "JSON that isn't an object",
      endpoint(CAPABILITIES["tiktok-business"]),
      "application/json",
      '["client_secret"]',
      /not a JSON object/,
    ],
    [
      "a multipart body",
      endpoint(CAPABILITIES.reddit),
      "multipart/form-data; boundary=x",
      '--x\r\nContent-Disposition: form-data; name="client_secret"\r\n\r\napp-secret\r\n--x--',
      /form-encoded .* or JSON/,
    ],
    [
      "a body without a type",
      endpoint(CAPABILITIES.dribbble),
      "",
      "client_secret=app-secret",
      /form-encoded .* or JSON/,
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
      "a JSON body",
      request("https://x.example/t", '{"grant_type":"authorization_code"}', {
        "content-type": "application/json",
      }),
      "authorization_code",
    ],
    [
      "the query string",
      request(
        "https://x.example/t?grant_type=fb_exchange_token&fb_exchange_token=t",
        null,
      ),
      "fb_exchange_token",
    ],
    [
      "a value it doesn't know (a token, say)",
      request("https://x.example/t?grant_type=EAAB-user-token", null),
      "other",
    ],
    [
      "no grant type (Meta's code exchange)",
      request("https://x.example/t?code=c", null),
      null,
    ],
  ])("reads %s", (_case, sent, grantType) => {
    expect(tokenGrantType(sent)).toBe(grantType);
  });
});

describe("oauthClientCredentials", () => {
  it("needs the id and the secret", () => {
    const linkedin: OAuthClientCapability = CAPABILITIES.linkedin;
    expect(oauthClientCredentials(linkedin, {})).toBeNull();
    expect(
      oauthClientCredentials(linkedin, { LINKEDIN_CLIENT_ID: "id" }),
    ).toBeNull();
    expect(
      oauthClientCredentials(linkedin, {
        LINKEDIN_CLIENT_ID: " id ",
        LINKEDIN_CLIENT_SECRET: " secret ",
      }),
    ).toEqual({ clientId: "id", clientSecret: "secret" });
  });

  it("needs an https instance when MASTODON_URL is set, and takes mastodon.social when not", () => {
    const mastodon: OAuthClientCapability = CAPABILITIES.mastodon;
    const client = { MASTODON_CLIENT_ID: "id", MASTODON_CLIENT_SECRET: "s" };
    expect(oauthClientCredentials(mastodon, client)).toEqual({
      clientId: "id",
      clientSecret: "s",
    });
    expect(
      oauthClientCredentials(mastodon, {
        ...client,
        MASTODON_URL: "http://fosstodon.org",
      }),
    ).toBeNull();
  });
});
