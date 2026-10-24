import { describe, expect, it } from "vitest";
import { createCfApi, createFakeCfFetch } from "./cf";
import { FakeSandbox } from "./sandbox";
import { createFakeSpawn } from "./spawn";
import type { Account } from "./types";
import {
  BUNDLE_PATH,
  CHECKOUT_PATH,
  createBundle,
  siblingEnv,
  SiblingError,
  TokenGateError,
  withTestAccount,
} from "./withTestAccount";

const ID = "0123456789abcdef0123456789abcdef";
const account: Account = {
  name: "loop-1",
  accountId: ID,
  zone: "everyapp-loop1.com",
  email: "owner@everyapp-loop1.com",
  token: "fake-token-abcdefghijklmnopqrstuv",
};

const gateCf = (accounts: string[]) => {
  const fake = createFakeCfFetch([
    {
      method: "GET",
      path: /^\/user\/tokens\/verify$/,
      reply: () => ({ result: { id: "t", status: "active" } }),
    },
    {
      method: "GET",
      path: /^\/accounts$/,
      reply: () => ({ result: accounts.map((id) => ({ id })) }),
    },
  ]);
  return createCfApi({
    token: account.token,
    accountId: ID,
    fetch: fake.fetch,
  });
};

describe("siblingEnv", () => {
  it("is exactly the token and the account id, plus the allowlist for the teardown child", () => {
    expect(siblingEnv(account, false)).toEqual({
      CLOUDFLARE_API_TOKEN: account.token,
      CLOUDFLARE_ACCOUNT_ID: ID,
    });
    expect(siblingEnv(account, true)).toEqual({
      CLOUDFLARE_API_TOKEN: account.token,
      CLOUDFLARE_ACCOUNT_ID: ID,
      EVERYAPP_TEST_ACCOUNTS: ID,
    });
    expect(
      Object.keys(siblingEnv(account, true, { EVERYAPP_EVENT_LOG: "/loop/e" })),
    ).toEqual([
      "EVERYAPP_EVENT_LOG",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
      "EVERYAPP_TEST_ACCOUNTS",
    ]);
  });
});

describe("withTestAccount", () => {
  it("gates first: a token that sees two accounts creates nothing", async () => {
    const sandbox = new FakeSandbox();
    await expect(
      withTestAccount(
        {
          sandbox,
          image: "img",
          account,
          runId: "r1",
          bundlePath: null,
          cf: gateCf([ID, "f".repeat(32)]),
        },
        async () => "ran",
      ),
    ).rejects.toThrow(TokenGateError);
    expect(sandbox.created).toHaveLength(0);
  });

  it("creates the sibling with the three variables, clones the bundle, installs, runs, destroys", async () => {
    const sandbox = new FakeSandbox((call) =>
      call.argv[1] === "everyapp" ? { stdout: ['{"type":"done"}'] } : undefined,
    );
    const lines: string[] = [];
    const answer = await withTestAccount(
      {
        sandbox,
        image: "everyapp-loop:abc",
        account,
        runId: "2026-10-25T10:00-teardown-abc123",
        allowlist: true,
        bundlePath: "/tmp/launch.bundle",
        cf: gateCf([ID]),
        onLine: (line) => lines.push(line.line),
      },
      async (sibling) => {
        expect(sibling.checkout).toBe(CHECKOUT_PATH);
        const out = await sibling.everyapp([
          "teardown",
          "--account-id",
          ID,
          "--dry-run",
          "--json",
        ]);
        return out.stdout;
      },
    );
    expect(answer).toEqual(['{"type":"done"}']);
    const spec = sandbox.created[0]!;
    expect(spec.name).toMatch(/^loop-sib-teardown-abc123-[0-9a-f]{4}$/);
    expect(spec).toMatchObject({
      image: "everyapp-loop:abc",
      user: "dev",
      workdir: "/work",
      platform: "linux/arm64",
    });
    expect(spec.env).toEqual({
      CLOUDFLARE_API_TOKEN: account.token,
      CLOUDFLARE_ACCOUNT_ID: ID,
      EVERYAPP_TEST_ACCOUNTS: ID,
    });
    expect(sandbox.copiedIn).toEqual([
      {
        name: spec.name,
        hostPath: "/tmp/launch.bundle",
        sandboxPath: BUNDLE_PATH,
      },
    ]);
    expect(sandbox.execs.map((call) => call.argv)).toEqual([
      ["git", "clone", "-q", BUNDLE_PATH, CHECKOUT_PATH],
      ["pnpm", "install"],
      [
        "pnpm",
        "everyapp",
        "teardown",
        "--account-id",
        ID,
        "--dry-run",
        "--json",
      ],
    ]);
    expect(sandbox.execs[1]?.options.cwd).toBe(CHECKOUT_PATH);
    expect(sandbox.execs[2]?.options.cwd).toBe(CHECKOUT_PATH);
    expect(lines).toEqual(['{"type":"done"}']);
    expect(sandbox.destroyed).toEqual([spec.name]);
  });

  it("destroys the sibling when the clone, the install or the work fails", async () => {
    const failing = new FakeSandbox((call) =>
      call.argv[1] === "install"
        ? { code: 1, stderr: ["ERR_PNPM"] }
        : undefined,
    );
    await expect(
      withTestAccount(
        {
          sandbox: failing,
          image: "img",
          account,
          runId: "r",
          bundlePath: "/tmp/b",
          cf: null,
        },
        async () => "ran",
      ),
    ).rejects.toThrow(SiblingError);
    expect(failing.destroyed).toHaveLength(1);
    const throwing = new FakeSandbox();
    await expect(
      withTestAccount(
        {
          sandbox: throwing,
          image: "img",
          account,
          runId: "r",
          bundlePath: null,
          cf: null,
        },
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");
    expect(throwing.destroyed).toHaveLength(1);
    expect(throwing.execs).toHaveLength(0);
  });

  it("a signal already aborted when the sibling exists destroys it at once: no clone, no work, both hooks called", async () => {
    const sandbox = new FakeSandbox();
    const stopped = new AbortController();
    stopped.abort(new Error("the driver was stopped"));
    const seen: string[] = [];
    await expect(
      withTestAccount(
        {
          sandbox,
          image: "img",
          account,
          runId: "r",
          bundlePath: "/tmp/b",
          cf: null,
          signal: stopped.signal,
          onCreated: (handle) => seen.push(`created ${handle.name}`),
          onDestroyed: (handle) => seen.push(`destroyed ${handle.name}`),
        },
        async () => "ran",
      ),
    ).rejects.toThrow("the driver was stopped");
    expect(sandbox.created).toHaveLength(1);
    expect(sandbox.destroyed).toEqual([sandbox.created[0]!.name]);
    expect(sandbox.execs).toHaveLength(0);
    expect(sandbox.copiedIn).toHaveLength(0);
    expect(seen).toEqual([
      `created ${sandbox.created[0]!.name}`,
      `destroyed ${sandbox.created[0]!.name}`,
    ]);
    // Not aborted: the same options run as before.
    const live = new FakeSandbox();
    await expect(
      withTestAccount(
        {
          sandbox: live,
          image: "img",
          account,
          runId: "r",
          bundlePath: null,
          cf: null,
          signal: new AbortController().signal,
        },
        async () => "ran",
      ),
    ).resolves.toBe("ran");
    expect(live.destroyed).toHaveLength(1);
  });

  it("without a bundle there is no checkout and everyapp refuses", async () => {
    const sandbox = new FakeSandbox();
    await withTestAccount(
      {
        sandbox,
        image: "img",
        account,
        runId: "r",
        bundlePath: null,
        cf: null,
      },
      async (sibling) => {
        expect(sibling.checkout).toBeNull();
        await expect(sibling.everyapp(["status"])).rejects.toThrow(
          /no checkout/,
        );
        await sibling.exec(["date"]);
      },
    );
    expect(sandbox.execs.map((call) => call.argv)).toEqual([["date"]]);
  });
});

describe("createBundle", () => {
  it("resolves the ref and bundles it on the host", async () => {
    const { spawn, calls } = createFakeSpawn((call) =>
      call.args[0] === "rev-parse"
        ? { stdout: ["9821d457deadbeef"] }
        : undefined,
    );
    expect(
      await createBundle(spawn, "/repo", "HEAD", "/tmp/launch.bundle"),
    ).toEqual({ commit: "9821d457deadbeef" });
    expect(calls.map((call) => [call.bin, ...call.args])).toEqual([
      ["git", "rev-parse", "--verify", "HEAD^{commit}"],
      ["git", "bundle", "create", "/tmp/launch.bundle", "HEAD"],
    ]);
    const bad = createFakeSpawn(() => ({
      code: 128,
      stderr: ["fatal: Needed a single revision"],
    }));
    await expect(
      createBundle(bad.spawn, "/repo", "nope", "/tmp/x"),
    ).rejects.toThrow(/single revision/);
  });
});
