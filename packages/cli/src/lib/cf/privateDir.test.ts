import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestHome } from "@/test/home";
import { cfNeutralDir, makeCfTempDir, othersCanWrite } from "./privateDir";

const posix = process.platform !== "win32";

let home: string;
let sharedTmp: string;

beforeEach(() => {
  home = makeTestHome();
  vi.stubEnv("HOME", home);
  // The shared temp directory, where anyone could have prepared things.
  sharedTmp = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-shared-tmp-"));
  vi.stubEnv("TMPDIR", sharedTmp);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(sharedTmp, { recursive: true, force: true });
});

const cfHome = () => path.join(home, ".everyapp", "cf");
const mode = (target: string) => fs.lstatSync(target).mode & 0o777;

describe("cf's private directories", () => {
  it("live under ~/.everyapp, never in the shared temp directory", async () => {
    fs.writeFileSync(path.join(sharedTmp, "cloudflare.config.ts"), "export default {};");
    fs.mkdirSync(path.join(sharedTmp, "everyapp-cf-neutral"));

    const neutral = await cfNeutralDir();
    const temp = await makeCfTempDir("files-");

    expect(neutral).toBe(path.join(cfHome(), "neutral"));
    expect(path.dirname(temp)).toBe(path.join(cfHome(), "tmp"));
    for (const dir of [neutral, temp]) {
      expect(fs.realpathSync(dir).startsWith(fs.realpathSync(sharedTmp))).toBe(false);
      if (posix) expect(mode(dir)).toBe(0o700);
    }
    if (posix) expect(mode(cfHome())).toBe(0o700);
  });

  it("replaces a symlink someone left in their place, without following it", async () => {
    const elsewhere = path.join(sharedTmp, "attacker");
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, "cloudflare.config.ts"), "export default {};");
    fs.mkdirSync(cfHome(), { recursive: true, mode: 0o700 });
    fs.symlinkSync(elsewhere, path.join(cfHome(), "neutral"));

    const neutral = await cfNeutralDir();

    expect(fs.lstatSync(neutral).isSymbolicLink()).toBe(false);
    expect(fs.readdirSync(neutral)).toEqual([]);
    expect(fs.existsSync(path.join(elsewhere, "cloudflare.config.ts"))).toBe(true);
  });

  it.runIf(posix)("recreates one that others could write to", async () => {
    const neutral = path.join(cfHome(), "neutral");
    fs.mkdirSync(neutral, { recursive: true });
    fs.chmodSync(neutral, 0o777);
    fs.writeFileSync(path.join(neutral, "cloudflare.config.ts"), "export default {};");

    await expect(cfNeutralDir()).resolves.toBe(neutral);
    expect(mode(neutral)).toBe(0o700);
    expect(fs.readdirSync(neutral)).toEqual([]);
  });

  it("removes what runs killed outright left behind a day ago", async () => {
    const tmp = path.dirname(await makeCfTempDir("files-"));
    // Left by a run that is gone: its pid in the names, as makeCfTempDir
    // puts it there.
    const gone = spawnSync(process.execPath, ["-e", ""]).pid;
    const secrets = path.join(tmp, `files-${gone}-AbC123`);
    const release = path.join(tmp, `gateway-release-${gone}-XyZ789`);
    for (const dir of [secrets, release]) fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(path.join(secrets, "secrets.json"), "{}");
    const ours = await makeCfTempDir("gateway-release-");

    // A day later, as far as the sweep can tell.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 25 * 60 * 60_000);
    try {
      await makeCfTempDir("files-");

      expect(fs.existsSync(secrets)).toBe(false);
      expect(fs.existsSync(release)).toBe(false);
      // This run's own, however long a prompt keeps it waiting.
      expect(fs.existsSync(ours)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a tree a run still uses, whatever mtime tar gave it", async () => {
    // A release extracted just now: tar sets its mtime to the build time.
    const release = await makeCfTempDir("gateway-release-");
    const built = new Date(Date.now() - 30 * 24 * 60 * 60_000);
    fs.utimesSync(release, built, built);

    await makeCfTempDir("files-");

    expect(fs.existsSync(release)).toBe(true);
  });

  it("refuses to run cf below a cloudflare.config.ts", async () => {
    fs.writeFileSync(path.join(home, "cloudflare.config.ts"), "export default {};");

    await expect(cfNeutralDir()).rejects.toMatchObject({
      code: "UNSAFE_CF_DIRECTORY",
      message: expect.stringContaining(path.join(fs.realpathSync(home), "cloudflare.config.ts")),
    });
    await expect(makeCfTempDir("files-")).rejects.toMatchObject({
      code: "UNSAFE_CF_DIRECTORY",
    });
  });

  it.runIf(posix)("makes private again a ~/.everyapp an older CLI left open to its group", async () => {
    // A mkdir under umask 002 (Ubuntu, Debian, Fedora) made it 0775.
    const everyapp = path.join(home, ".everyapp");
    fs.mkdirSync(everyapp);
    fs.chmodSync(everyapp, 0o775);
    fs.writeFileSync(path.join(everyapp, "installs.json"), "{}", { mode: 0o600 });

    await expect(cfNeutralDir()).resolves.toBe(path.join(cfHome(), "neutral"));

    expect(mode(everyapp)).toBe(0o700);
    expect(fs.readFileSync(path.join(everyapp, "installs.json"), "utf8")).toBe("{}");
  });

  it("lets root run below a HOME another user owns, never one others can write to", () => {
    const runnersHome = { uid: 1001, mode: 0o40755 };
    // A CI container: root, with the runner's HOME.
    expect(othersCanWrite(runnersHome, { uid: 0, parent: true })).toBeNull();
    expect(
      othersCanWrite({ ...runnersHome, mode: 0o40775 }, { uid: 0, parent: true }),
    ).toBe("is writable by other users");
    // But not with that user's ~/.everyapp (`sudo` keeping HOME): root
    // would leave directories there the user can't use.
    expect(othersCanWrite(runnersHome, { uid: 0 })).toBe("is owned by another user");
    // Anyone else: only their own directories, and root's.
    expect(othersCanWrite(runnersHome, { uid: 501, parent: true })).toBe(
      "is owned by another user",
    );
    expect(othersCanWrite({ uid: 0, mode: 0o40755 }, { uid: 501, parent: true })).toBeNull();
  });

  it.runIf(posix)("refuses sudo with the user's HOME", async () => {
    vi.stubEnv("SUDO_UID", String(process.getuid!()));
    vi.spyOn(process as { getuid: () => number }, "getuid").mockReturnValue(0);
    try {
      await expect(cfNeutralDir()).rejects.toMatchObject({
        code: "UNSAFE_CF_DIRECTORY",
        message: expect.stringContaining("Run it without sudo"),
      });
      expect(fs.existsSync(path.join(home, ".everyapp"))).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.runIf(posix)("refuses a home other users can write above", async () => {
    const shared = path.join(home, "shared");
    fs.mkdirSync(shared);
    fs.chmodSync(shared, 0o777);
    const nested = path.join(shared, "user");
    fs.mkdirSync(nested);
    vi.stubEnv("HOME", nested);

    await expect(cfNeutralDir()).rejects.toMatchObject({
      code: "UNSAFE_CF_DIRECTORY",
      message: expect.stringContaining("writable by other users"),
    });
  });
});
