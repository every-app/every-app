// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { UserAccessApp } from "@/types/app";
import {
  isSameSite,
  openableHosts,
  preconnectTo,
  speculationRulesFor,
} from "./appLaunchPrefetch";

const UNREADY: UserAccessApp["setup"] = {
  ready: false,
  settings: [],
  unmet: [],
  groups: [],
  command: { command: "pnpm everyapp secret set DATAFORSEO_API_KEY" },
};

function app(
  overrides: Partial<
    Pick<UserAccessApp, "hostname" | "status" | "setup" | "tier">
  > = {},
) {
  return {
    hostname: "seo.apps.example.com",
    tier: "service_binding",
    status: "active",
    setup: null,
    ...overrides,
  };
}

const SITE = "apps.example.com";

describe("isSameSite", () => {
  it("takes the gateway's own subdomains and its registrable domain", () => {
    expect(isSameSite("crm.apps.example.com", "apps.example.com")).toBe(true);
    expect(isSameSite("crm.example.com", "gateway.example.com")).toBe(true);
    expect(isSameSite("CRM.Apps.Example.com", "apps.example.com")).toBe(true);
    expect(isSameSite("todo.localhost", "localhost")).toBe(true);
  });

  it("refuses another site, a third-party app's home", () => {
    expect(isSameSite("crm-acme.apps-of-others.example", SITE)).toBe(false);
    expect(isSameSite("example.com.evil.test", SITE)).toBe(false);
    expect(isSameSite("notapps.example.net", SITE)).toBe(false);
  });
});

describe("openableHosts", () => {
  it("lists only the apps that open on the launcher's site, each host once", () => {
    expect(
      openableHosts(
        [
          app(),
          app({ hostname: "crm.apps.example.com" }),
          // The same host twice (two grants to one app) is one entry.
          app({ hostname: "crm.apps.example.com" }),
          app({ hostname: "setup.apps.example.com", setup: UNREADY }),
          app({ hostname: "deploying.apps.example.com", status: "binding" }),
          app({ hostname: "off.apps.example.com", status: "disabled" }),
          app({ hostname: "pending.apps.example.com", status: "pending" }),
          app({ hostname: null }),
          app({ hostname: "tools.apps.example.com", tier: "provider" }),
          // A third-party app: another site, prefetched without cookies.
          app({ hostname: "third-acme.apps-of-others.example" }),
        ],
        SITE,
      ),
    ).toEqual(["seo.apps.example.com", "crm.apps.example.com"]);
  });

  it("is empty when nothing opens", () => {
    expect(openableHosts([], SITE)).toEqual([]);
    expect(openableHosts([app({ setup: UNREADY })], SITE)).toEqual([]);
  });
});

describe("speculationRulesFor", () => {
  it("is a list-source prefetch of each host's root at moderate eagerness", () => {
    const json = speculationRulesFor([
      "seo.apps.example.com",
      "crm.apps.example.com",
    ]);
    expect(JSON.parse(json)).toEqual({
      prefetch: [
        {
          source: "list",
          urls: [
            "https://seo.apps.example.com/",
            "https://crm.apps.example.com/",
          ],
          eagerness: "moderate",
        },
      ],
    });
  });

  it("lists a host once however many times it is given", () => {
    const rules = JSON.parse(
      speculationRulesFor(["seo.apps.example.com", "seo.apps.example.com"]),
    ) as { prefetch: { urls: string[] }[] };
    expect(rules.prefetch[0]?.urls).toEqual(["https://seo.apps.example.com/"]);
  });

  it("names the apps that open, from the library's list", () => {
    const rules = JSON.parse(
      speculationRulesFor(
        openableHosts(
          [app(), app({ hostname: "setup.apps.example.com", setup: UNREADY })],
          SITE,
        ),
      ),
    ) as { prefetch: { urls: string[] }[] };
    expect(rules.prefetch[0]?.urls).toEqual(["https://seo.apps.example.com/"]);
  });
});

describe("preconnectTo", () => {
  const links = (host: string) =>
    document.head.querySelectorAll(
      `link[rel="preconnect"][href="https://${host}"]`,
    );

  it("adds one preconnect link per host, without crossorigin", () => {
    preconnectTo("seo.apps.example.com");
    preconnectTo("crm.apps.example.com");
    expect(links("seo.apps.example.com")).toHaveLength(1);
    expect(links("crm.apps.example.com")).toHaveLength(1);
    expect(links("seo.apps.example.com")[0]?.hasAttribute("crossorigin")).toBe(
      false,
    );
  });

  it("does nothing the second time for the same host, within ten seconds", () => {
    preconnectTo("again.apps.example.com", 1_000);
    preconnectTo("again.apps.example.com", 2_000);
    preconnectTo("again.apps.example.com", 9_000);
    expect(links("again.apps.example.com")).toHaveLength(1);
  });

  it("asks for a fresh connection once the last one has gone stale", () => {
    preconnectTo("stale.apps.example.com", 1_000);
    const first = links("stale.apps.example.com")[0];
    preconnectTo("stale.apps.example.com", 12_000);
    const fresh = links("stale.apps.example.com");
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).not.toBe(first);
    expect(first?.isConnected).toBe(false);
  });
});
