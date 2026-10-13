import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryGatewayD1 = vi.hoisted(() => vi.fn());

vi.mock("@/lib/cloudflare/gatewayD1", () => ({ queryGatewayD1 }));

import {
  gatewayHasOwner,
  mintSetupLink,
  setupLinkForDeploy,
} from "./setup-link";

const database = { accountId: "account-id", databaseId: "database-id" };

describe("mintSetupLink", () => {
  beforeEach(() => {
    queryGatewayD1.mockReset();
    queryGatewayD1.mockResolvedValue([]);
  });

  it("stores only the SHA-256 of a fresh est_ secret, which rides in the fragment", async () => {
    const now = 1_700_000_000_000;
    const link = await mintSetupLink({
      ...database,
      gatewayUrl: "https://gateway.example.com/",
      now,
    });

    const match = link.url.match(
      /^https:\/\/gateway\.example\.com\/setup#token=(est_[A-Za-z0-9_-]{43})$/,
    );
    expect(match).not.toBeNull();
    const token = match![1]!;
    expect(link.expiresAt).toEqual(new Date(now + 24 * 60 * 60 * 1000));

    const [expireCall, insertCall] = queryGatewayD1.mock.calls;
    expect(expireCall).toEqual([
      "account-id",
      "database-id",
      expect.stringMatching(/^UPDATE owner_setup_tokens SET expires_at = \?/),
      [now],
    ]);
    expect(insertCall?.[2]).toMatch(/^INSERT INTO owner_setup_tokens/);
    expect(insertCall?.[3]).toEqual([
      expect.any(String),
      createHash("sha256").update(token).digest("hex"),
      now + 24 * 60 * 60 * 1000,
    ]);
    expect(JSON.stringify(queryGatewayD1.mock.calls)).not.toContain(token);
  });

  it("mints a different secret every time", async () => {
    const a = await mintSetupLink({ ...database, gatewayUrl: "https://g.x" });
    const b = await mintSetupLink({ ...database, gatewayUrl: "https://g.x" });
    expect(a.url).not.toBe(b.url);
  });
});

describe("gatewayHasOwner", () => {
  it("reads owner memberships from D1", async () => {
    queryGatewayD1.mockResolvedValueOnce([{ found: 1 }]);
    await expect(gatewayHasOwner(database)).resolves.toBe(true);

    queryGatewayD1.mockResolvedValueOnce([]);
    await expect(gatewayHasOwner(database)).resolves.toBe(false);
    expect(queryGatewayD1).toHaveBeenLastCalledWith(
      "account-id",
      "database-id",
      "SELECT 1 AS found FROM members WHERE role = ? LIMIT 1",
      ["owner"],
    );
  });
});

describe("setupLinkForDeploy", () => {
  const isTTY = process.stdout.isTTY;
  const deploy = (printSetupLink?: boolean) =>
    setupLinkForDeploy({
      ...database,
      gatewayUrl: "https://gateway.example.com",
      printSetupLink,
    });
  const inserts = () =>
    queryGatewayD1.mock.calls.filter(([, , sql]) =>
      String(sql).startsWith("INSERT"),
    );

  function runIn(terminal: boolean, ci: boolean) {
    Object.defineProperty(process.stdout, "isTTY", {
      value: terminal,
      configurable: true,
    });
    vi.stubEnv("CI", ci ? "true" : "");
  }

  beforeEach(() => {
    queryGatewayD1.mockReset();
    // No owner yet; every other statement returns nothing.
    queryGatewayD1.mockResolvedValue([]);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: isTTY,
      configurable: true,
    });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("mints the link for someone at a terminal", async () => {
    runIn(true, false);

    const link = await deploy();
    expect(link?.url).toMatch(/\/setup#token=est_/);
    expect(inserts()).toHaveLength(1);
  });

  it("never prints a link into CI or piped logs, only how to get one", async () => {
    for (const [terminal, ci] of [
      [true, true],
      [false, false],
    ] as const) {
      runIn(terminal, ci);
      vi.mocked(console.log).mockClear();

      await expect(deploy()).resolves.toBeNull();

      const output = vi.mocked(console.log).mock.calls.flat().join("\n");
      expect(output).toContain("Gateway is unclaimed");
      expect(output).toContain("npx everyapp gateway claim-link");
      expect(output).not.toContain("est_");
    }
    // Nothing minted, so a link the deployer already has keeps working.
    expect(inserts()).toEqual([]);
    expect(
      queryGatewayD1.mock.calls.map(([, , sql]) => sql),
    ).not.toContainEqual(expect.stringMatching(/^UPDATE owner_setup_tokens/));
  });

  it("prints the link in CI when asked to", async () => {
    runIn(false, true);

    await expect(deploy(true)).resolves.toMatchObject({
      url: expect.stringContaining("/setup#token=est_"),
    });
  });

  it("does nothing for a gateway that has an owner", async () => {
    runIn(true, false);
    queryGatewayD1.mockResolvedValueOnce([{ found: 1 }]);

    await expect(deploy(true)).resolves.toBeNull();
    expect(queryGatewayD1).toHaveBeenCalledTimes(1);
  });
});
