import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { forbiddenAccountIds, forbiddenAccountsPath } from "./forbidden";

/** Made-up ids: the real live account lives in the machine's config file, never in code. */
const A = "badc0ffee0ddf00dbadc0ffee0ddf00d";
const B = "0123456789abcdef0123456789abcdef";

const dirs: string[] = [];
const tempHome = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-forbidden-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("forbiddenAccountIds", () => {
  it("is empty with neither the variable nor the file", () => {
    expect(forbiddenAccountIds({}, tempHome())).toEqual([]);
  });

  it("is the variable and the file together, each id once, lowercased", () => {
    const home = tempHome();
    const file = forbiddenAccountsPath({}, home);
    expect(file).toBe(
      path.join(home, ".config", "everyapp", "forbidden-accounts"),
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `# live\n${B.toUpperCase()}\nnot-an-id\n${A}\n`);
    expect(
      forbiddenAccountIds({ EVERYAPP_FORBIDDEN_ACCOUNTS: `${A}, junk` }, home),
    ).toEqual([A, B]);
  });

  it("reads the file under $XDG_CONFIG_HOME when set", () => {
    const home = tempHome();
    const xdg = path.join(home, "xdg");
    fs.mkdirSync(path.join(xdg, "everyapp"), { recursive: true });
    fs.writeFileSync(
      path.join(xdg, "everyapp", "forbidden-accounts"),
      `${A}\n`,
    );
    expect(forbiddenAccountIds({ XDG_CONFIG_HOME: xdg }, home)).toEqual([A]);
  });
});
