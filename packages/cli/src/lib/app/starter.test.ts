import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyStarter, starterTemplateDir } from "./starter";

const dirs: string[] = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-starter-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("the starter template", () => {
  it("is found in the monorepo from source", () => {
    const dir = starterTemplateDir();
    expect(dir).not.toBeNull();
    expect(fs.existsSync(path.join(dir!, "everyapp.config.ts"))).toBe(true);
  });

  it("copies as the app it is asked to be, without local state, its .gitignore restored", async () => {
    // As bundled: .gitignore shipped as gitignore, and a stray local state
    // directory a developer's checkout could have.
    const template = tmp();
    fs.cpSync(starterTemplateDir()!, template, {
      recursive: true,
      filter: (source) => !source.includes("node_modules"),
    });
    fs.renameSync(path.join(template, ".gitignore"), path.join(template, "gitignore"));
    fs.mkdirSync(path.join(template, ".cloudflare", "state"), { recursive: true });
    fs.writeFileSync(path.join(template, ".dev.vars"), "SECRET=1");

    const target = path.join(tmp(), "simple-todo");
    await copyStarter({ templateDir: template, targetDir: target, appId: "simple-todo" });

    expect(fs.readFileSync(path.join(target, "everyapp.config.ts"), "utf8")).toContain(
      'id: "simple-todo"',
    );
    expect(JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8")).name).toBe(
      "simple-todo",
    );
    expect(fs.readFileSync(path.join(target, ".gitignore"), "utf8")).toContain(".dev.vars");
    expect(fs.existsSync(path.join(target, "gitignore"))).toBe(false);
    expect(fs.existsSync(path.join(target, ".cloudflare"))).toBe(false);
    expect(fs.existsSync(path.join(target, ".dev.vars"))).toBe(false);
  });
});
