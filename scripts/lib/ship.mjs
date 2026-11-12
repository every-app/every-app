/**
 * `pnpm release ship`: what it would push to the public repository, and the
 * push. Kept apart from scripts/release.mjs so it can be run against
 * throwaway repositories (ship.test.mjs): everything here takes the
 * checkout and the public repository's URL, and nothing asks or prints.
 */
import { execFileSync, spawnSync } from "node:child_process";

/** A reason ship won't push; its message is what the person reads. */
export class ShipRefusal extends Error {}

const gitIn = (root) => (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * What a push of this checkout's main to the public repository would be:
 * the commits the public main doesn't have, oldest last. Reads only (two
 * fetches). Refuses a checkout that isn't a clean, current main, and a
 * push that wouldn't be a fast-forward.
 */
export function planShip({ root, publicUrl }) {
  const git = gitIn(root);
  if (git("status", "--porcelain") !== "") {
    throw new ShipRefusal("the git tree has changes; commit or stash them first, so what is released is a commit.");
  }
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== "main") {
    throw new ShipRefusal(`this checkout is on ${branch}, not main. Ship from main: git switch main && git pull`);
  }
  git("fetch", "--quiet", "origin", "main");
  const head = git("rev-parse", "HEAD");
  if (head !== git("rev-parse", "origin/main")) {
    throw new ShipRefusal("main isn't what origin/main is. git pull (or push what is only here), then run this again.");
  }
  let publicHead;
  try {
    git("fetch", "--quiet", publicUrl, "main");
    publicHead = git("rev-parse", "FETCH_HEAD");
  } catch (error) {
    throw new ShipRefusal(`couldn't read the public repository's main (${publicUrl}): ${String(error.stderr ?? error.message).trim()}`);
  }
  if (publicHead === head) return { head, publicHead, commits: [] };
  if (spawnSync("git", ["merge-base", "--is-ancestor", publicHead, head], { cwd: root }).status !== 0) {
    throw new ShipRefusal(
      `the public repository's main (${publicHead.slice(0, 8)}) has commits this main doesn't, so the push wouldn't be a fast-forward.\nSomething was merged on the public repository. Bring it into the private main first; never force the push.`,
    );
  }
  const commits = git("log", "--first-parent", "--format=%h %s", `${publicHead}..${head}`).split("\n").filter(Boolean);
  return { head, publicHead, commits };
}

/** Push exactly `head` to the public repository's main: a fast-forward, never forced. */
export function pushShip({ root, publicUrl, head }) {
  execFileSync("git", ["push", publicUrl, `${head}:refs/heads/main`], { cwd: root, stdio: "inherit" });
}

/** The lines that show a plan: how many commits, the range, and the newest `limit` of them. */
export function planLines({ head, publicHead, commits }, limit = 15) {
  if (commits.length === 0) return ["  Commits    none: the public main is already at this commit"];
  return [
    `  Commits    ${commits.length} (${publicHead.slice(0, 8)}..${head.slice(0, 8)})`,
    ...commits.slice(0, limit).map((line) => `    ${line}`),
    ...(commits.length > limit ? [`    and ${commits.length - limit} more`] : []),
  ];
}

/**
 * ship's closing lines about the apps' pins. An app re-pins when it needs
 * something from the new version, not because a release happened: `refused`
 * is the public apps whose latest release this CLI won't install
 * ({ repo, why }), and only those are told to.
 */
export function repinLines({ version, refused }) {
  if (refused.length === 0) {
    return [
      "",
      `No app needs re-pinning: everyapp ${version} installs every public app's latest release.`,
      "Re-pin an app when it needs something from this version (.github/RELEASE.md, \"When an app re-pins\").",
      "",
    ];
  }
  return [
    "",
    `everyapp ${version} won't install ${refused.length === 1 ? "this app's latest release" : "these apps' latest releases"}. Re-pin ${refused.length === 1 ? "it" : "each"} and release it again:`,
    ...refused.flatMap(({ repo, why }) => [
      "",
      `  ${repo}`,
      `    ${why}`,
      "",
      `  pnpm pack-for-app ../${repo.replace(/\/+$/, "").split("/").at(-1)} --npm ${version}`,
    ]),
    "",
    "No other app needs re-pinning.",
    "",
  ];
}
