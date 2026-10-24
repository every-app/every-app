import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  execCapture,
  FakeSandbox,
  removeSecretEnvFile,
  writeSecretEnvFile,
} from "./sandbox";
import type { SandboxSpec } from "./types";

const spec: SandboxSpec = {
  name: "loop-test",
  image: "everyapp-loop:test",
  platform: "linux/arm64",
  cpus: 4,
  memory: "6g",
  env: {
    CLOUDFLARE_API_TOKEN: "fake-token-000000000000",
    CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  },
  user: "dev",
  workdir: "/work",
};

describe("sandbox helpers", () => {
  it("writes the env file readable by this user alone, in a directory likewise, and removes both", () => {
    const file = writeSecretEnvFile({
      CLOUDFLARE_API_TOKEN: "fake-token-000000000000",
      EVERYAPP_EVENT_LOG: "/loop/e.ndjson",
    });
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe("600");
    expect((fs.statSync(path.dirname(file)).mode & 0o777).toString(8)).toBe(
      "700",
    );
    expect(fs.readFileSync(file, "utf8")).toBe(
      "CLOUDFLARE_API_TOKEN=fake-token-000000000000\nEVERYAPP_EVENT_LOG=/loop/e.ndjson\n",
    );
    removeSecretEnvFile(file);
    expect(fs.existsSync(path.dirname(file))).toBe(false);
    expect(() => writeSecretEnvFile({ X: "a\nb" })).toThrow(/newline/);
  });
});

describe("FakeSandbox", () => {
  it("records creates, streams scripted lines to onLine, records copies and destroys", async () => {
    const sandbox = new FakeSandbox((call) =>
      call.argv[0] === "echo"
        ? { stdout: ["hello"], stderr: ["warn"], code: 0 }
        : { code: 3 },
    );
    const handle = await sandbox.create(spec);
    expect(sandbox.created[0]?.env).toEqual(spec.env);
    const out = await execCapture(sandbox, handle, ["echo", "hi"], {
      cwd: "/work/every-app",
    });
    expect(out).toMatchObject({
      result: { exitCode: 0, killed: false },
      stdout: ["hello"],
      stderr: ["warn"],
    });
    expect(sandbox.execs[0]).toMatchObject({
      name: "loop-test",
      argv: ["echo", "hi"],
      options: { cwd: "/work/every-app" },
    });
    expect((await sandbox.exec(handle, ["false"])).exitCode).toBe(3);
    await sandbox.copyIn(handle, "/tmp/launch.bundle", "/loop/launch.bundle");
    await sandbox.copyOut(handle, "/loop", "/tmp/out");
    sandbox.diffEntries = [
      { kind: "added", path: "/work/every-app/apps/hello" },
    ];
    expect(await sandbox.diff(handle)).toEqual([
      { kind: "added", path: "/work/every-app/apps/hello" },
    ]);
    await sandbox.destroy(handle);
    expect(sandbox.copiedIn).toHaveLength(1);
    expect(sandbox.copiedOut).toHaveLength(1);
    expect(sandbox.destroyed).toEqual(["loop-test"]);
  });

  it("a hanging exec ends through the AbortSignal or the timeout, marked killed", async () => {
    const sandbox = new FakeSandbox(() => ({ hang: true }));
    const handle = await sandbox.create(spec);
    const controller = new AbortController();
    const pending = sandbox.exec(handle, ["sleep", "infinity"], {
      signal: controller.signal,
    });
    controller.abort();
    expect(await pending).toMatchObject({ exitCode: 137, killed: true });
    expect(
      await sandbox.exec(handle, ["sleep", "infinity"], { timeoutMs: 5 }),
    ).toMatchObject({ killed: true });
  });

  it("tails feed the lines pushed to their path until closed", async () => {
    const sandbox = new FakeSandbox();
    const handle = await sandbox.create(spec);
    const seen: string[] = [];
    const tail = await sandbox.tailFile(
      handle,
      "/loop/everyapp-events.ndjson",
      (line) => seen.push(line),
    );
    sandbox.pushTail("/loop/everyapp-events.ndjson", '{"type":"invocation"}');
    sandbox.pushTail("/loop/other", "ignored");
    await tail.close();
    sandbox.pushTail("/loop/everyapp-events.ndjson", "after close");
    expect(seen).toEqual(['{"type":"invocation"}']);
    expect(sandbox.tails[0]?.closed).toBe(true);
  });
});
