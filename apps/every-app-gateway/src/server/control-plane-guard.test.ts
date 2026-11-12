/**
 * The control plane's guard on the Allow page's form
 * (docs/design/2026-11-oauth-one-connection.md): `POST
 * /connect/<provider>/allow` rides the session cookie, so it gets the
 * Origin check every cookie request gets, and the page it is posted from
 * is never cached.
 */
import { describe, expect, it } from "vitest";
import {
  guardControlPlaneRequest,
  withControlPlaneHeaders,
} from "./control-plane-guard";

const HOST = "gateway.example.com";

/** The Allow page's form as a browser with a session posts it. */
function allowPost(headers: Record<string, string>): Request {
  return new Request(`https://${HOST}/connect/google-workspace/allow`, {
    method: "POST",
    headers: { cookie: "session=abc", ...headers },
    body: new URLSearchParams({ state: "a-state", decision: "approve" }),
  });
}

describe("the control plane's guard on the Allow page's form", () => {
  it("refuses a cookie POST to /connect/<id>/allow forged from another site, a sibling app, or with no origin at all", async () => {
    const forged: Record<string, string>[] = [
      { origin: "https://evil.example.net", "sec-fetch-site": "cross-site" },
      // A page on one of the Gateway's own apps is same-site, and no closer.
      {
        origin: "https://notes.apps.example.com",
        "sec-fetch-site": "same-site",
      },
      { origin: "https://evil.example.net" },
      {},
    ];
    for (const headers of forged) {
      const refused = guardControlPlaneRequest(allowPost(headers), HOST);
      expect(refused?.status, JSON.stringify(headers)).toBe(403);
      expect(await refused!.json()).toMatchObject({ error: "csrf_denied" });
    }
  });

  it("lets the Gateway's own page post it", () => {
    expect(
      guardControlPlaneRequest(
        allowPost({
          origin: `https://${HOST}`,
          "sec-fetch-site": "same-origin",
        }),
        HOST,
      ),
    ).toBeNull();
  });

  it("never caches the Allow page", () => {
    const page = withControlPlaneHeaders(
      new Response("<html></html>", {
        headers: { "content-type": "text/html" },
      }),
      "/oauth/app-access",
    );
    expect(page.headers.get("cache-control")).toBe("no-store");
  });
});
