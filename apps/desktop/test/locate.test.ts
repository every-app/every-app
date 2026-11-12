import { describe, expect, it } from "vitest";
import { locateApp } from "../src/main/auth/locate";
import { OAuthClient, type Fetch } from "../src/main/auth/oauth";
import { backendAppIds, SCRIBE } from "../src/shared/features";

/** Public sign-in metadata, by URL; anything else is a 404 (what an unknown app host answers). */
function fetchFrom(documents: Record<string, unknown>): { fetch: Fetch; asked: string[] } {
  const asked: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    const doc = documents[url];
    if (doc === undefined) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(doc), { status: 200, headers: { "content-type": "application/json" } });
  }) as Fetch;
  return { fetch, asked };
}

const gateway = (issuer: string) => ({
  [`${issuer}/.well-known/oauth-authorization-server`]: {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    code_challenge_methods_supported: ["S256"],
  },
});

const app = (origin: string, issuer: string) => ({
  [`${origin}/.well-known/oauth-protected-resource`]: { resource: origin, authorization_servers: [issuer] },
});

const locate = (text: string, docs: Record<string, unknown>) => {
  const { fetch, asked } = fetchFrom(docs);
  return { result: locateApp(text, ["talk"], new OAuthClient(fetch), "Scribe"), asked };
};

/** Scribe as the app ships it: `scribe`, formerly `talk`. */
const locateScribe = (text: string, docs: Record<string, unknown>) => {
  const { fetch, asked } = fetchFrom(docs);
  return { result: locateApp(text, backendAppIds(SCRIBE), new OAuthClient(fetch), "Scribe"), asked };
};

describe("locateApp: a Gateway's address or the app's own", () => {
  it("a Gateway's address finds the app at talk.<gateway host>", async () => {
    const { result } = locate("apps.acme.com", {
      ...gateway("https://apps.acme.com"),
      ...app("https://talk.apps.acme.com", "https://apps.acme.com"),
    });
    await expect(result).resolves.toEqual({ kind: "app", appUrl: "https://talk.apps.acme.com", gatewayUrl: "https://apps.acme.com" });
  });

  it("accepts a pasted URL with a path and a trailing slash", async () => {
    const { result } = locate(" https://apps.acme.com/admin/ ", {
      ...gateway("https://apps.acme.com"),
      ...app("https://talk.apps.acme.com", "https://apps.acme.com"),
    });
    await expect(result).resolves.toMatchObject({ kind: "app", appUrl: "https://talk.apps.acme.com" });
  });

  it("the app's own address is used as is, without asking the Gateway", async () => {
    const { result, asked } = locate("https://talk.apps.acme.com", app("https://talk.apps.acme.com", "https://apps.acme.com"));
    await expect(result).resolves.toEqual({ kind: "app", appUrl: "https://talk.apps.acme.com" });
    expect(asked).toEqual(["https://talk.apps.acme.com/.well-known/oauth-protected-resource"]);
  });

  it("a hosted Gateway's app host (talk-<org>) counts as the app's own", async () => {
    const { result } = locate("talk-k3x9.everyapp.dev", app("https://talk-k3x9.everyapp.dev", "https://everyapp.dev"));
    await expect(result).resolves.toMatchObject({ kind: "app", appUrl: "https://talk-k3x9.everyapp.dev" });
  });

  it("a Gateway without the app: missing, with where it will be", async () => {
    const { result } = locate("apps.acme.com", gateway("https://apps.acme.com"));
    await expect(result).resolves.toEqual({ kind: "missing", gatewayUrl: "https://apps.acme.com", appUrl: "https://talk.apps.acme.com" });
  });

  it("an app that signs in with another Gateway is refused", async () => {
    const { result } = locate("apps.acme.com", {
      ...gateway("https://apps.acme.com"),
      ...app("https://talk.apps.acme.com", "https://evil.example"),
    });
    await expect(result).rejects.toThrow("Scribe at talk.apps.acme.com signs in with a different Gateway.");
  });

  it("an address that isn't a Gateway says so", async () => {
    const { result } = locate("acme.com", {});
    await expect(result).rejects.toThrow("acme.com doesn't answer like an Every App Gateway.");
  });

  it("a Gateway whose metadata names another issuer isn't one", async () => {
    const { result } = locate("apps.acme.com", {
      "https://apps.acme.com/.well-known/oauth-authorization-server": gateway("https://other.example")[
        "https://other.example/.well-known/oauth-authorization-server"
      ],
    });
    await expect(result).rejects.toThrow("doesn't answer like an Every App Gateway");
  });

  it("refuses plain http off the local hosts, and empty input", async () => {
    await expect(locate("http://apps.acme.com", {}).result).rejects.toThrow("Type your Gateway's address");
    await expect(locate("   ", {}).result).rejects.toThrow("Type your Gateway's address");
  });

  it("local development: http on .localhost", async () => {
    const { result } = locate("http://localhost:8787", {
      ...gateway("http://localhost:8787"),
      ...app("http://talk.localhost:8787", "http://localhost:8787"),
    });
    await expect(result).resolves.toMatchObject({ kind: "app", appUrl: "http://talk.localhost:8787" });
  });
});

describe("locateApp: an app that was renamed (scribe, formerly talk)", () => {
  const GATEWAY = "https://apps.acme.com";
  const SCRIBE_URL = "https://scribe.apps.acme.com";
  const TALK_URL = "https://talk.apps.acme.com";

  it("looks for scribe first, then talk", () => {
    expect(backendAppIds(SCRIBE)).toEqual(["scribe", "talk"]);
  });

  it("a fresh Gateway, with only scribe", async () => {
    const { result } = locateScribe("apps.acme.com", { ...gateway(GATEWAY), ...app(SCRIBE_URL, GATEWAY) });
    await expect(result).resolves.toEqual({ kind: "app", appUrl: SCRIBE_URL, gatewayUrl: GATEWAY });
  });

  it("an old Gateway, with only talk", async () => {
    const { result, asked } = locateScribe("apps.acme.com", { ...gateway(GATEWAY), ...app(TALK_URL, GATEWAY) });
    await expect(result).resolves.toEqual({ kind: "app", appUrl: TALK_URL, gatewayUrl: GATEWAY });
    expect(asked).toEqual([
      `${GATEWAY}/.well-known/oauth-authorization-server`,
      `${SCRIBE_URL}/.well-known/oauth-protected-resource`,
      `${TALK_URL}/.well-known/oauth-protected-resource`,
    ]);
  });

  it("a renamed Gateway, with both: scribe, and talk isn't asked", async () => {
    const { result, asked } = locateScribe("apps.acme.com", {
      ...gateway(GATEWAY),
      ...app(SCRIBE_URL, GATEWAY),
      ...app(TALK_URL, GATEWAY),
    });
    await expect(result).resolves.toEqual({ kind: "app", appUrl: SCRIBE_URL, gatewayUrl: GATEWAY });
    expect(asked).not.toContain(`${TALK_URL}/.well-known/oauth-protected-resource`);
  });

  it("typed https://scribe.<base>: used as is", async () => {
    const { result, asked } = locateScribe(SCRIBE_URL, app(SCRIBE_URL, GATEWAY));
    await expect(result).resolves.toEqual({ kind: "app", appUrl: SCRIBE_URL });
    expect(asked).toEqual([`${SCRIBE_URL}/.well-known/oauth-protected-resource`]);
  });

  it("typed https://talk.<base>: used as is, even when scribe answers too", async () => {
    const { result, asked } = locateScribe(TALK_URL, { ...app(SCRIBE_URL, GATEWAY), ...app(TALK_URL, GATEWAY) });
    await expect(result).resolves.toEqual({ kind: "app", appUrl: TALK_URL });
    expect(asked).toEqual([`${TALK_URL}/.well-known/oauth-protected-resource`]);
  });

  it.each(["scribe", "talk"])("a hosted Gateway's %s-<org> host counts as the app's own", async (id) => {
    const origin = `https://${id}-k3x9.everyapp.dev`;
    const { result, asked } = locateScribe(`${id}-k3x9.everyapp.dev`, app(origin, "https://everyapp.dev"));
    await expect(result).resolves.toEqual({ kind: "app", appUrl: origin });
    expect(asked).toEqual([`${origin}/.well-known/oauth-protected-resource`]);
  });

  it("a Gateway with neither: missing, at the current id's host", async () => {
    const { result } = locateScribe("apps.acme.com", gateway(GATEWAY));
    await expect(result).resolves.toEqual({ kind: "missing", gatewayUrl: GATEWAY, appUrl: SCRIBE_URL });
  });

  it("only ever asks the typed host and its own subdomains", async () => {
    const { result, asked } = locateScribe("apps.acme.com", gateway(GATEWAY));
    await result;
    expect(asked.map((u) => new URL(u).host)).toEqual(["apps.acme.com", "scribe.apps.acme.com", "talk.apps.acme.com"]);
  });

  it("scribe signing in with another Gateway is refused, not skipped for talk", async () => {
    const { result } = locateScribe("apps.acme.com", {
      ...gateway(GATEWAY),
      ...app(SCRIBE_URL, "https://evil.example"),
      ...app(TALK_URL, GATEWAY),
    });
    await expect(result).rejects.toThrow("Scribe at scribe.apps.acme.com signs in with a different Gateway.");
  });
});
