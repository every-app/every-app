import { describe, expect, it } from "vitest";
import { hostAdmitsApp, routeHost, type HostProfile } from "./hostRoutes";

const HOSTED: HostProfile = {
  gatewayHost: "app.everyapp.com",
  thirdPartyDomain: "everyapp.dev",
};
const SELF_HOSTED: HostProfile = {
  gatewayHost: "apps.example.com",
  thirdPartyDomain: null,
};

describe("routeHost", () => {
  it("sends the gateway's own host, or none, to the control plane", () => {
    expect(routeHost("app.everyapp.com", HOSTED)).toEqual({
      kind: "control_plane",
    });
    expect(routeHost("", HOSTED)).toEqual({ kind: "control_plane" });
  });

  it("classes one label below the third-party domain as third-party, and nothing else there", () => {
    expect(routeHost("todo-acme.everyapp.dev", HOSTED)).toEqual({
      kind: "third_party",
    });
    for (const host of [
      "everyapp.dev",
      "a.todo-acme.everyapp.dev",
      "-todo.everyapp.dev",
      "todo-.everyapp.dev",
      `${"a".repeat(64)}.everyapp.dev`,
    ]) {
      expect(routeHost(host, HOSTED)).toEqual({ kind: "not_found" });
    }
    // Look-alikes are not under the domain.
    expect(routeHost("todo.noteveryapp.dev", HOSTED)).toEqual({
      kind: "first_party",
    });
  });

  it("classes every other host first-party, to be looked up as before", () => {
    for (const host of [
      "openseo.app.everyapp.com",
      "todo-acme.app.everyapp.com",
      "elsewhere.example",
      "localhost:8787",
    ]) {
      expect(routeHost(host, HOSTED)).toEqual({ kind: "first_party" });
    }
  });

  it("has no third-party class in the self-hosted profile: today's rules", () => {
    expect(routeHost("apps.example.com", SELF_HOSTED)).toEqual({
      kind: "control_plane",
    });
    for (const host of [
      "todo.apps.example.com",
      "todo-acme.apps.example.com",
      "todo-acme.everyapp.dev",
      "everyapp.dev",
      "a.b.everyapp.dev",
    ]) {
      expect(routeHost(host, SELF_HOSTED)).toEqual({ kind: "first_party" });
    }
    // Without GATEWAY_URL, only an empty host is the control plane's here;
    // the worker entry keeps its bootstrap rule for the rest.
    expect(
      routeHost("todo.apps.example.com", {
        gatewayHost: null,
        thirdPartyDomain: null,
      }),
    ).toEqual({ kind: "first_party" });
  });
});

describe("hostAdmitsApp", () => {
  it("serves dispatch apps of an organization on third-party hosts only", () => {
    const dispatch = { tier: "dispatch", scope: "org" } as const;
    expect(hostAdmitsApp({ kind: "third_party" }, dispatch)).toBe(true);
    expect(hostAdmitsApp({ kind: "first_party" }, dispatch)).toBe(false);
    expect(
      hostAdmitsApp(
        { kind: "third_party" },
        { tier: "dispatch", scope: "shared" },
      ),
    ).toBe(false);
  });

  it("serves service-binding apps, shared or an organization's, on first-party hosts only", () => {
    for (const scope of ["org", "shared"] as const) {
      const app = { tier: "service_binding", scope } as const;
      expect(hostAdmitsApp({ kind: "first_party" }, app)).toBe(true);
      expect(hostAdmitsApp({ kind: "third_party" }, app)).toBe(false);
      expect(hostAdmitsApp({ kind: "control_plane" }, app)).toBe(false);
      expect(hostAdmitsApp({ kind: "not_found" }, app)).toBe(false);
    }
  });
});
