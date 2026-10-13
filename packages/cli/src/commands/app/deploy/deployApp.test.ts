import { describe, expect, it } from "vitest";
import { appWorkerName, deriveAppHostnameFromIssuer } from "./deployApp";

describe("appWorkerName", () => {
  it("names the app's Worker", () => {
    expect(appWorkerName("todo")).toBe("every-todo");
  });

  it("refuses an app id that would deploy over the gateway", () => {
    expect(() => appWorkerName("app-gateway")).toThrow(/reserved/);
    expect(() => appWorkerName("every-app-gateway")).toThrow(/reserved/);
  });
});

describe("deriveAppHostnameFromIssuer", () => {
  it("derives the app hostname from the manifest id and issuer hostname", () => {
    expect(
      deriveAppHostnameFromIssuer("todo", "https://example.com/sign-in"),
    ).toEqual({
      hostname: "todo.example.com",
      apex: "example.com",
      issuerHost: "example.com",
      isWorkersDev: false,
    });
  });

  it("returns null when the gateway has no issuer yet", () => {
    expect(deriveAppHostnameFromIssuer("todo", null)).toBeNull();
    expect(deriveAppHostnameFromIssuer("todo", undefined)).toBeNull();
  });

  it("marks workers.dev issuers as unroutable for app subdomains", () => {
    expect(
      deriveAppHostnameFromIssuer(
        "todo",
        "https://every-app-gateway.account.workers.dev",
      ),
    ).toMatchObject({
      hostname: "todo.every-app-gateway.account.workers.dev",
      apex: "every-app-gateway.account.workers.dev",
      isWorkersDev: true,
    });
  });
});
