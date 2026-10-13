import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalContext } from "@/context";
import { requestedExitCode } from "@/lib/exit-code";
import { readGatewayCredential } from "@/lib/gateway/credentials";
import { listPendingClaims, writePendingClaim } from "@/lib/gateway/pendingClaims";
import { makeTestHome } from "@/test/home";
import { login } from ".";

let home: string;

beforeEach(() => {
  home = makeTestHome();
  vi.stubEnv("HOME", home);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("everyapp login --resume", () => {
  it("finishes the login setup was waiting for, with the secret it kept", async () => {
    await writePendingClaim({
      gatewayUrl: "https://apps.example.com",
      url: "https://apps.example.com/setup#token=est_link",
      cliSecret: "ecs_secret",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(
        JSON.stringify({
          token: "eak_token",
          organizationId: "org-1",
          organizationName: "Acme",
          ownerEmail: "ada@example.com",
        }),
        { status: 200 },
      );
    });

    await login.call({} as LocalContext, { resume: true });

    expect(requestedExitCode()).toBe(0);
    expect(requests).toEqual([
      { url: "https://apps.example.com/api/setup/deploy-token", body: { cliSecret: "ecs_secret" } },
    ]);
    await expect(readGatewayCredential("https://apps.example.com")).resolves.toMatchObject({
      token: "eak_token",
    });
    await expect(listPendingClaims()).resolves.toEqual([]);
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain(
      "Logged in to https://apps.example.com as ada@example.com (owner of Acme).",
    );
  });

  it("says so when no setup is waiting", async () => {
    await login.call({} as LocalContext, { resume: true });
    expect(requestedExitCode()).toBe(1);
  });

  it("never shows a link the gateway no longer waits on, and says what to do by whether it has an owner", async () => {
    const claim = {
      gatewayUrl: "https://apps.example.com",
      url: "https://apps.example.com/setup#token=est_link",
      cliSecret: "ecs_secret",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    let hasOwner = false;
    vi.stubGlobal("fetch", async (url: string) =>
      String(url).endsWith("/api/admin/has-owner")
        ? new Response(JSON.stringify({ hasOwner }), { status: 200 })
        : new Response(
            JSON.stringify({
              error: "This setup link is invalid, expired or already used.",
              code: "INVALID_OR_EXPIRED_SETUP_LINK",
            }),
            { status: 404 },
          ),
    );
    const printed = () =>
      [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls]
        .flat()
        .join("\n");

    // Replaced by a newer link, or expired, before anyone used it.
    await writePendingClaim(claim);
    await login.call({} as LocalContext, { resume: true });
    expect(requestedExitCode()).toBe(2);
    expect(printed()).not.toContain("#token=est_link");
    expect(printed()).toContain("again for a new link");
    expect(printed()).not.toContain("Admin → Tokens");
    await expect(listPendingClaims()).resolves.toEqual([]);

    // Claimed, and its login used or past its 30 minutes.
    hasOwner = true;
    await writePendingClaim(claim);
    await login.call({} as LocalContext, { resume: true });
    expect(requestedExitCode()).toBe(1);
    expect(printed()).toContain("Admin → Tokens");
  });
});
