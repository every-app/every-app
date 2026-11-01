/**
 * Where a webhook may deliver (lib/gateway/eventTarget.ts), the Gateway's
 * target rules as `events add` applies them before writing anything.
 */
import { describe, expect, it } from "vitest";
import { checkEventTarget, defaultTargetName, shownTarget } from "./eventTarget";

const RULES = { gatewayHost: "apps.acme.com", appBaseDomain: "apps.acme.com", allowPrivate: false };

describe("checkEventTarget", () => {
  it("takes a public https URL, query and port included, as the URL parser writes it", () => {
    expect(checkEventTarget(" https://Hooks.Slack.com/services/T0/B0/x?y=1 ", RULES)).toEqual({
      ok: true,
      url: "https://hooks.slack.com/services/T0/B0/x?y=1",
    });
    expect(checkEventTarget("https://n8n.example.org:8443/webhook", RULES)).toMatchObject({ ok: true });
  });

  it("refuses the Gateway's own host and anything under the apps' domain, a trailing dot included, even with the private setting", () => {
    for (const url of ["https://apps.acme.com/x", "https://crm.apps.acme.com/x", "https://CRM.apps.acme.com./x"]) {
      expect(checkEventTarget(url, { ...RULES, allowPrivate: true }), url).toMatchObject({ ok: false, private: false });
    }
    expect(checkEventTarget("https://acme.com/x", RULES)).toMatchObject({ ok: true });
  });

  it("refuses private names, IP literals and http: unless the Gateway allows private targets, as the Gateway's rule does", () => {
    for (const url of [
      "http://hooks.example.org/x",
      "https://localhost/x",
      "https://a.localhost/x",
      "https://nas.home.arpa/x",
      "https://x.onion/x",
      "https://intranet/x",
      "https://hooks.acme.corp/x",
      "https://n8n.lan/x",
      "https://box.intranet/x",
      "https://a.localdomain/x",
      "https://vault.private/x",
      "https://10.0.0.5/x",
      "https://2130706433/x",
      "https://[fd00::1]/x",
      "http://10.0.0.5:5678/webhook",
    ]) {
      expect(checkEventTarget(url, RULES), url).toMatchObject({ ok: false, private: true });
      expect(checkEventTarget(url, { ...RULES, allowPrivate: true }), url).toMatchObject({ ok: true });
    }
    // A public name that only contains a private word is public.
    expect(checkEventTarget("https://corp.example.com/x", RULES)).toMatchObject({ ok: true });
  });

  it("never repeats the URL in its reason, so a password typed into one isn't shown", () => {
    const checked = checkEventTarget("https://me:s3cret@hooks.example.org/x", RULES);
    expect(checked).toMatchObject({ ok: false });
    expect(JSON.stringify(checked)).not.toContain("s3cret");
  });
});

describe("shownTarget and defaultTargetName", () => {
  it("shows the host and path, never a query, and names a subscription after its host", () => {
    expect(shownTarget("https://hooks.zapier.com/hooks/catch/1/abc?token=q")).toBe("hooks.zapier.com/hooks/catch/1/abc");
    expect(shownTarget("https://hooks.example.org/")).toBe("hooks.example.org");
    expect(shownTarget("http://n8n.internal:5678/webhook")).toBe("http://n8n.internal:5678/webhook");
    expect(defaultTargetName("https://hooks.zapier.com/hooks/catch/1/abc")).toBe("hooks.zapier.com");
  });
});
