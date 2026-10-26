/**
 * What the public copy leaves out, rewrites and refuses, and why.
 *
 * scripts/public-copy.mjs applies this; docs/runbooks/public-copy.md explains
 * it to a person. Three kinds of rule:
 *
 * - exclude: files of the source tree that never travel.
 * - scrub: rewrites applied to the planning documents (TODO.md, docs/),
 *   not to code. The names that must not travel (private repositories, people,
 *   local paths) are in private.txt beside this file, which the copy leaves
 *   out; that file is absent in the public repository, where this policy
 *   alone runs as a guard against new leaks.
 * - deny: what fails the build if it is still there afterwards: file names
 *   that only ever hold credentials, and secret shapes in any text file.
 *
 * Everything here is generic. Nothing in this file names a private thing.
 */
import fs from "node:fs";

export const policy = {
  /** The clone URL the README must give. */
  publicCloneUrl: "https://github.com/every-app/every-app",

  /** The only remote --push accepts without --any-remote: the public repository, over https or ssh. */
  publicRemote: /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)every-app\/every-app(?:\.git)?\/?$/i,

  /** A README link that must not appear. */
  refusedLink: /github\.com\/[^/\s]+\/private-|t3-thread:\/\//i,

  /** A remote the push step refuses, whatever the flags. */
  refusedRemote: /private-|bensenescu\//i,

  /** Files that must read as text; one that looks binary fails the build instead of escaping the content check. */
  textFiles: /\.(md|mdx|txt|json|jsonc|ya?ml|toml|ts|tsx|js|mjs|cjs|css|html|sql|env|example|sh)$/i,

  exclude: [
    {
      pattern: /^scripts\/public-copy\/private\.txt$/,
      why: "the list of private names this script scrubs: the list itself stays home",
    },
    {
      pattern: /(^|\/)\.worktreeinclude$/,
      why: "worktree tooling of the maintainers' checkout",
    },
    {
      pattern: /^docs\/overnight\//,
      why: "overnight build logs (launch doc B9)",
    },
    {
      pattern: /^landing-page\/content\/internal\//,
      why: "the unpublished internal docs (launch doc G)",
    },
    {
      pattern: /(^|\/)[^/]+\.local(\.[a-z0-9]+)?$/,
      why: "local overrides (*.local, settings.local.json)",
    },
  ],

  /** The files the scrub rules rewrite: the planning documents, not the code. */
  scrubFiles: /^(TODO\.md|docs\/.*\.md)$/,

  scrub: [
    {
      // Every e-mail address except the role addresses, the examples and the
      // dev addresses (keep). Package scopes (@tanstack/x) don't match: no
      // dotted domain follows the @.
      pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[a-z]{2,}\b/g,
      keep: /^git@|^(?:support|hello|security|info|noreply|no-reply)@|@(?:[a-z0-9.-]+\.)?(?:example\.(?:com|net|org)|acme\.[a-z]+|users\.noreply\.github\.com)$|\.(?:example|test|invalid|localhost)$|example/i,
      replace: "an e-mail address",
      why: "a personal e-mail address",
    },
  ],

  /**
   * A match that is plainly a stand-in, not a secret: a run of one character,
   * the alphabet, the digits, or a word that says so. Excused by every
   * denyContent rule that isn't strict; the private names are strict.
   */
  obviousFake: /(.)\1{7,}|ABCDEFGHIJKLMNOP|0123456789|fake|test|sample|example|placeholder|dummy|REPLACE/i,

  /** File names that only ever hold credentials. Matched on the base name. */
  denyNames: [
    { pattern: /^1k(\..*)?$/, why: "the Cloudflare token file committed in #488" },
    { pattern: /^accounts(\..*)?\.json(\..*)?$/, why: "the onboarding loop's test accounts and their tokens" },
    { pattern: /^providers\.env(\..*)?$/, why: "the onboarding loop's provider keys" },
    { pattern: /^\.dev\.vars(\..*)?$/, allow: /\.example$/, why: "local dev secrets" },
    { pattern: /^\.env(\..*)?$/, allow: /\.example$/, why: "an environment file" },
    { pattern: /\.(pem|key|p12|pfx|jks|keystore|ppk)$/, why: "key material" },
    { pattern: /^id_(rsa|dsa|ecdsa|ed25519)$/, why: "an SSH private key" },
    { pattern: /^secrets\.env$/, why: "the Gateway's secrets file" },
    { pattern: /^\.npmrc$/, why: "may carry a registry token" },
    { pattern: /^\.netrc$/, why: "credentials" },
    { pattern: /^(credentials|service-account[^/]*)\.json$/, why: "credentials" },
  ],

  /**
   * Secret shapes and private places, in any text file of the copy. A match
   * fails the build unless allowMatch excuses it (an obvious fake) or
   * allowFiles excuses the file (the documented dev keypair).
   */
  denyContent: [
    { name: "a Cloudflare account API token", pattern: /\bcfat_[A-Za-z0-9_-]{20,}/, strict: true },
    {
      name: "a Cloudflare API token beside the word token",
      pattern:
        /\b(?:token|api[_-]?token|cloudflare[_a-z]*token|cf[_-]?token|CLOUDFLARE_API_TOKEN)\b["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{40}(?![A-Za-z0-9_-])/i,
      allowMatch: /0123456789|x{10,}|0{10,}|fake|test/i,
    },
    { name: "an Anthropic key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/, allowMatch: /fake|test|0000|something/i },
    { name: "an OpenAI or OpenRouter key", pattern: /\bsk-(?:proj-|or-v1-)[A-Za-z0-9_-]{20,}/, allowMatch: /fake|test|0000/i },
    { name: "a GitHub token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}/ },
    { name: "a Slack token", pattern: /\bxox[abpr]-[A-Za-z0-9-]{20,}/ },
    { name: "an AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
    {
      name: "a private key block",
      pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----\s*[A-Za-z0-9+/=\s]{40,}/,
      allowFiles: /^packages\/sdk\/src\/dev\/keypair\.ts$/,
      strict: true,
    },
    {
      name: "a Better Auth secret value",
      pattern: /BETTER_AUTH_SECRET\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{32,}/,
      allowMatch: /test-secret|fake|x{16,}|0{16,}/i,
    },
    { name: "a setup link token", pattern: /\best_[A-Za-z0-9]{24,}\b/, allowMatch: /0000|test|fake|x{8,}/i },
    { name: "a Resend key", pattern: /\bre_[A-Za-z0-9]{24,}\b/, allowMatch: /0000|test|fake|x{8,}/i },
    {
      name: "a signed token (JWT) outside the tests",
      pattern: /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{20,}/,
      allowFiles: /\.test\.(ts|tsx|mjs)$|\/fixtures\/|\/test\//,
    },
    { name: "a T3 thread link", pattern: /t3-thread:\/\//i, strict: true },
    { name: "a link into a private GitHub repository", pattern: /github\.com\/[^/\s"')]+\/private-[^\s"')]*/i, strict: true },
    { name: "the maintainer's home directory", pattern: /\/Users\/bensenescu\b/i, strict: true },
  ],
};

/**
 * private.txt: one rule per line, `/<regex>/<flags>` TAB replacement TAB why;
 * `#` starts a comment. The rules scrub the documents and, afterwards, fail
 * the build wherever one still matches. Returns null when the file is absent
 * (the public repository).
 */
export function loadPrivateNames(file) {
  if (!fs.existsSync(file)) return null;
  const rules = [];
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (!line.trim() || line.startsWith("#")) return;
    const match = /^\/(.+)\/([a-z]*)\t([^\t]*)\t(.+)$/.exec(line);
    if (!match) throw new Error(`${file}:${i + 1}: expected /regex/flags<TAB>replacement<TAB>why`);
    // Every rule is global and case-insensitive: repository names, paths and
    // hostnames don't care about case, and a leak in another case is a leak.
    const flags = [...new Set([...match[2], "g", "i"])].join("");
    const pattern = new RegExp(match[1], flags);
    if (new RegExp(match[1], flags.replace("g", "")).test("")) throw new Error(`${file}:${i + 1}: the pattern matches the empty string`);
    const groups = new RegExp(`${match[1]}|`).exec("").length - 1;
    for (const ref of match[3].matchAll(/\$(\d)/g)) {
      if (Number(ref[1]) > groups) throw new Error(`${file}:${i + 1}: the replacement uses $${ref[1]} but the pattern has ${groups} group(s)`);
    }
    rules.push({ pattern, replace: match[3], why: match[4] });
  });
  return rules;
}
