import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPathArgument, resolveAppTarget, resolvePathArgument } from "./appId";

const cwd = "/work/every-app";
const home = "/home/sam";
const resolve = (given: string | undefined, options: { interactive?: boolean; yes?: boolean } = {}) =>
  resolveAppTarget(given, { interactive: false, yes: false, cwd, home, ...options });

describe("a name or a path", () => {
  it("is a path when it has a slash or starts with ., ~ or /", () => {
    for (const given of [
      "../my-app",
      "..\\my-app",
      "apps/my-app",
      "apps\\my-app",
      "./my-app",
      ".\\my-app",
      ".",
      "..",
      "~",
      "~/my-app",
      "~\\my-app",
      "/srv/my-app",
      "my-app/",
      "my-app\\",
      "C:\\projects\\my-app",
    ]) {
      expect(isPathArgument(given), given).toBe(true);
    }
    for (const given of ["my-app", "analytics", "crm2", "My_App"]) {
      expect(isPathArgument(given), given).toBe(false);
    }
  });

  it("resolves a relative path from the current directory, ~ from home, and an absolute path as it is", () => {
    expect(resolvePathArgument("../my-app", { cwd, home })).toBe(path.resolve(cwd, "../my-app"));
    expect(resolvePathArgument("apps/my-app", { cwd, home })).toBe(path.resolve(cwd, "apps/my-app"));
    expect(resolvePathArgument("apps\\my-app", { cwd, home })).toBe(path.resolve(cwd, "apps/my-app"));
    expect(resolvePathArgument("./my-app/", { cwd, home })).toBe(path.resolve(cwd, "my-app"));
    expect(resolvePathArgument(".\\my-app\\", { cwd, home })).toBe(path.resolve(cwd, "my-app"));
    expect(resolvePathArgument("my-app/", { cwd, home })).toBe(path.resolve(cwd, "my-app"));
    expect(resolvePathArgument("my-app\\", { cwd, home })).toBe(path.resolve(cwd, "my-app"));
    expect(resolvePathArgument("~", { cwd, home })).toBe(path.resolve(home));
    expect(resolvePathArgument("~/apps/my-app", { cwd, home })).toBe(path.resolve(home, "apps/my-app"));
    expect(resolvePathArgument("~\\apps\\my-app", { cwd, home })).toBe(path.resolve(home, "apps/my-app"));
    expect(resolvePathArgument("/srv/my-app", { cwd, home })).toBe(path.resolve("/srv/my-app"));
  });
});

describe("resolveAppTarget", () => {
  it("keeps a bare name as the app id, with no directory of its own", async () => {
    await expect(resolve("my-app")).resolves.toEqual({ appId: "my-app", dir: null, absolute: false });
  });

  it("names the app after the last part of a path, relative from here", async () => {
    await expect(resolve("../my-app")).resolves.toEqual({ appId: "my-app", dir: path.resolve(cwd, "../my-app"), absolute: false });
    await expect(resolve("apps/my-app/")).resolves.toEqual({
      appId: "my-app",
      dir: path.resolve(cwd, "apps/my-app"),
      absolute: false,
    });
    await expect(resolve("apps\\my-app\\")).resolves.toEqual({
      appId: "my-app",
      dir: path.resolve(cwd, "apps/my-app"),
      absolute: false,
    });
    await expect(resolve("apps\\my-app")).resolves.toEqual({
      appId: "my-app",
      dir: path.resolve(cwd, "apps/my-app"),
      absolute: false,
    });
  });

  it("treats a name with a trailing slash or backslash as a path, stripped to its name", async () => {
    expect(isPathArgument("my-app/")).toBe(true);
    expect(resolvePathArgument("my-app/", { cwd, home })).toBe(path.resolve(cwd, "my-app"));
    await expect(resolve("my-app/")).resolves.toEqual({
      appId: "my-app",
      dir: path.resolve(cwd, "my-app"),
      absolute: false,
    });

    expect(isPathArgument("my-app\\")).toBe(true);
    expect(resolvePathArgument("my-app\\", { cwd, home })).toBe(path.resolve(cwd, "my-app"));
    await expect(resolve("my-app\\")).resolves.toEqual({
      appId: "my-app",
      dir: path.resolve(cwd, "my-app"),
      absolute: false,
    });
  });

  it("says an absolute path, and one from ~, is shown whole", async () => {
    await expect(resolve("/srv/apps/my-app")).resolves.toEqual({ appId: "my-app", dir: path.resolve("/srv/apps/my-app"), absolute: true });
    await expect(resolve("~/my-app")).resolves.toEqual({ appId: "my-app", dir: path.resolve(home, "my-app"), absolute: true });
    await expect(resolve("~\\my-app")).resolves.toEqual({ appId: "my-app", dir: path.resolve(home, "my-app"), absolute: true });
    if (process.platform === "win32") {
      await expect(resolve("C:\\projects\\custom\\my-app")).resolves.toEqual({
        appId: "my-app",
        dir: "C:\\projects\\custom\\my-app",
        absolute: true,
      });
    }
  });

  it("refuses a path whose last part isn't a valid app name, saying which part", async () => {
    await expect(resolve("../My_App")).rejects.toMatchObject({
      code: "INVALID_APP_ID",
      message: '"My_App" isn\'t a valid app name\nAn app is named after the last part of its path, ../My_App.',
      fix: "use lowercase letters, digits and dashes, e.g. my-app",
    });
    await expect(resolve("~/everyapp")).rejects.toMatchObject({
      code: "INVALID_APP_ID",
      message: '"everyapp" is reserved for the platform\nAn app is named after the last part of its path, ~/everyapp.',
    });
  });

  it("refuses a bad bare name, or none when it may not ask, as before", async () => {
    await expect(resolve("My_App")).rejects.toMatchObject({
      code: "INVALID_APP_ID",
      message: '"My_App" isn\'t a valid app name',
    });
    await expect(resolve(undefined)).rejects.toMatchObject({
      code: "APP_ID_REQUIRED",
      rerun: "pnpm everyapp create <name>",
    });
    await expect(resolve(undefined, { yes: true })).rejects.toMatchObject({
      code: "APP_ID_REQUIRED",
      rerun: "pnpm everyapp create <name> --yes",
    });
  });
});
