// scripts/release-mac.sh --publish when main moved on during the build, against throwaway repositories:
// a bare "origin", the release checkout and a second clone that lands commits on main. pnpm (wrangler)
// and curl are stubs, so nothing leaves the machine.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const desktop = resolve(import.meta.dirname, "..");
const TAG = "everyapp-desktop-v0.1.1";
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A release of 0.1.1 built and tagged on `work`'s main, not yet pushed. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "release-publish-"));
  dirs.push(root);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd: join(root, cwd), env, encoding: "utf8", stdio: "pipe" }).trim();
  const write = (path: string, text: string) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  git(".", "init", "-q", "--bare", "-b", "main", "origin.git");
  git(".", "init", "-q", "-b", "main", "work");
  git("work", "remote", "add", "origin", join(root, "origin.git"));
  mkdirSync(join(root, "work/apps/desktop/scripts"), { recursive: true });
  copyFileSync(join(desktop, "scripts/release-mac.sh"), join(root, "work/apps/desktop/scripts/release-mac.sh"));
  copyFileSync(join(desktop, "identity.json"), join(root, "work/apps/desktop/identity.json"));
  write("work/apps/desktop/package.json", '{ "version": "0.1.0" }\n');
  write("work/apps/desktop/.gitignore", "releases\n");
  write("work/apps/desktop/src/a.ts", "a\n");
  write("work/README.md", "readme\n");
  git("work", "add", "-A");
  git("work", "commit", "-q", "-m", "base");
  git("work", "push", "-q", "origin", "main");
  git(".", "clone", "-q", "origin.git", "other");

  write("work/apps/desktop/package.json", '{ "version": "0.1.1" }\n');
  git("work", "commit", "-q", "-am", "Every App desktop 0.1.1");
  git("work", "tag", "-a", TAG, "-m", "Every App desktop 0.1.1");
  write("work/apps/desktop/releases/0.1.1/latest-mac.yml", "version: 0.1.1\n");
  write("work/apps/desktop/releases/0.1.1/EveryApp-0.1.1-arm64.dmg", "dmg\n");

  write("bin/pnpm", "#!/bin/sh\nexit 0\n");
  write("bin/curl", '#!/bin/sh\ncase "$*" in *-o*) exit 0;; *latest-mac.yml) echo "version: 0.1.1";; esac\n');
  for (const name of ["pnpm", "curl"]) chmodSync(join(root, "bin", name), 0o755);

  /** Someone else's pull request merges: a commit on origin's main that changes `path`. */
  const land = (path: string) => {
    git("other", "pull", "-q", "origin", "main");
    write(join("other", path), `${Math.random()}\n`);
    git("other", "add", "-A");
    git("other", "commit", "-q", "-m", `land ${path}`);
    git("other", "push", "-q", "origin", "HEAD:main");
  };
  const publish = () => {
    const run = spawnSync("bash", [join(root, "work/apps/desktop/scripts/release-mac.sh"), "--publish", "0.1.1"], {
      env: { ...env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: run.status, out: run.stdout + run.stderr };
  };
  return { root, git, write, land, publish };
}

describe("release-mac.sh --publish when main moved on", () => {
  it("rebases the release commit, moves the tag with its message, and pushes both", () => {
    const { git, land, publish } = setup();
    land("README.md");
    land("apps/desktop/docs/notes.md");
    const { status, out } = publish();
    expect(out).toContain(`main moved on while 0.1.1 was building: rebased the release commit onto it and moved ${TAG}.`);
    expect(out).toContain("Published Every App 0.1.1");
    expect(status).toBe(0);
    expect(git("origin.git", "log", "--format=%s", "main").split("\n")).toEqual(["Every App desktop 0.1.1", "land apps/desktop/docs/notes.md", "land README.md", "base"]);
    expect(git("origin.git", "rev-parse", `${TAG}^{commit}`)).toBe(git("origin.git", "rev-parse", "main"));
    expect(git("origin.git", "cat-file", "-t", TAG)).toBe("tag");
    expect(git("origin.git", "tag", "-l", "--format=%(contents:subject)", TAG)).toBe("Every App desktop 0.1.1");
  });

  it("refuses without a terminal when the app's source changed, and leaves git alone", () => {
    const { git, land, publish } = setup();
    const before = git("work", "rev-parse", "HEAD", TAG);
    land("apps/desktop/src/a.ts");
    const { status, out } = publish();
    expect(status).toBe(1);
    expect(out).toContain("the built app differs from the source");
    expect(out).toContain("    apps/desktop/src/a.ts");
    expect(out).toContain(`git tag -d ${TAG} && git reset -q --hard origin/main && rm -rf releases/0.1.1`);
    expect(out).toContain("scripts/release-mac.sh --release --bump 0.1.1");
    expect(git("work", "rev-parse", "HEAD", TAG)).toBe(before);
    expect(git("origin.git", "tag", "-l")).toBe("");
  });

  it.each(["a second local commit", "a dirty tree", "another branch checked out", "a lightweight tag"])("stops with the old message for %s", (state) => {
    const { git, write, land, publish } = setup();
    land("README.md");
    if (state === "a second local commit") {
      write("work/extra.txt", "x\n");
      git("work", "add", "-A");
      git("work", "commit", "-q", "-m", "extra");
      git("work", "tag", "-f", "-a", TAG, "-m", "moved");
    } else if (state === "a dirty tree") write("work/README.md", "edited\n");
    else if (state === "another branch checked out") git("work", "checkout", "-q", "-b", "side");
    else git("work", "tag", "-f", TAG);
    const before = git("work", "rev-parse", "HEAD", TAG);
    const { status, out } = publish();
    expect(status).toBe(1);
    expect(out).toContain(`Couldn't push. If main moved on, bring ${TAG} onto main, then run: scripts/release-mac.sh --publish 0.1.1`);
    expect(out).not.toContain("rebased");
    expect(git("work", "rev-parse", "HEAD", TAG)).toBe(before);
    expect(git("origin.git", "tag", "-l")).toBe("");
  });

  it("tries once more when main moves again between the fetch and the push", () => {
    const { root, git, write, land, publish } = setup();
    land("README.md");
    const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    // A git that lands one more commit on origin's main just before the first push.
    write(
      "bin/git",
      `#!/bin/sh
case " $* " in *" push --atomic "*)
  if [ ! -e "${root}/raced" ]; then
    touch "${root}/raced"
    (cd "${root}/other" && "${real}" pull -q origin main && echo race >> README.md && "${real}" commit -q -am race && "${real}" push -q origin HEAD:main)
  fi;;
esac
exec "${real}" "$@"
`,
    );
    chmodSync(join(root, "bin/git"), 0o755);
    const { status, out } = publish();
    expect(out).toContain("The push was refused; fetching main and trying once more.");
    expect(status).toBe(0);
    expect(git("origin.git", "log", "--format=%s", "main").split("\n")).toEqual(["Every App desktop 0.1.1", "race", "land README.md", "base"]);
    expect(git("origin.git", "rev-parse", `${TAG}^{commit}`)).toBe(git("origin.git", "rev-parse", "main"));
  });
});
