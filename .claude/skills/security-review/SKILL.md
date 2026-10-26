---
name: security-review
description: Review the branch's pending changes for security problems against Every App's threat model, with pnpm security-review (Claude Code's scanner plus this repository's boundaries and false-positive rules); use before opening a pull request that touches the perimeter, identity, public routes, tools, OAuth, Access, secrets or queries.
---

# Security review

## When

Before a pull request that touches a trust boundary: the perimeter
(`packages/perimeter`), identity (the SDK's verifier, the Gateway's sessions
and sign-in), public routes, tools and `/mcp`, OAuth, Cloudflare Access,
secrets, deploys, or a query that scopes by user or organization. Not for
prose: `docs/`, `prompts/`, `landing-page/content/`, `*.md` and
`pnpm-lock.yaml` are not reviewed, and a branch that changes only those is
refused as nothing to review.

The model reads the diff as instructions too: the review is a second pair of
eyes on your own changes, never a gate on a stranger's. On a contributor's
branch read the diff yourself first, and read their changes to `scripts/`,
`.claude/`, `.agents/` and `package.json` before running the command, which
runs the branch's own copy of the script.

## The command

From the checkout root:

```
pnpm security-review                 the branch against origin/main, plus the working tree
pnpm security-review --base main     against another ref
pnpm security-review --staged        only what is committed or staged
pnpm security-review --json          the findings as JSON
pnpm security-review --model opus    another model than Claude Code's default
```

It is one non-interactive Claude Code run (`claude -p --restricted`) on your
own Claude Code login, with read-only tools confined to the checkout (Read,
Grep, Glob: no commands, no edits, no MCP servers, and the branch's own
`.claude` settings and hooks ignored), over the diff since the branch left
the base plus whatever is edited and not yet committed, untracked files
included. A file whose name only ever holds credentials (`.env`, `*.pem`,
`providers.env`, `accounts.json`, the public copy's list in
`scripts/public-copy/policy.mjs`) is never sent; stderr names what was sent
and what was kept back. When the diff is too long for one prompt it runs
again with the file list and no diff, and the model reads the files. It
needs `claude` on PATH and signed in (https://docs.claude.com/en/docs/claude-code).
Expect a few minutes and the run's tokens; the summary line prints the cost.

The prompt is `scripts/security-review.mjs` putting together the audit prompt
of Anthropic's security review for Claude Code
(`scripts/security-review/audit-prompt.md`, pinned to the upstream commit
named in it), this repository's boundaries
(`scripts/security-review/scan-instructions.md`: the one list, don't copy it
elsewhere), its false-positive rules (`scripts/security-review/false-positives.md`)
and a pointer to `docs/threat-model.md`, the model every finding is judged
against. There is no CI job: the review runs where you run.

## Reading the output

One block per finding: `SEVERITY file:line category`, what is wrong, the
exploit scenario (which actor from the threat model does what), the fix.
Exit 1 while a high or medium finding remains, 0 when none does (a low
finding is printed and does not fail), 2 when the review could not run (no
`claude`, nothing to review, no answer it could read). `--json` gives
`{ branch, base, mergeBase, files, rulesChanged, findings[], summary, counts, run }`
(`run`: the cost, the duration, the model, whether the diff went). A deleted
file is listed as `path (deleted)`. When the branch changed the review's own
rules (`scripts/security-review/`, the script, this skill), a stderr line
names the files: `*.md` keeps them out of the diff, so read them.

## With a finding

1. Real: fix it on the branch, pin it with a test, and when it is a new
   invariant add the row to `docs/threat-model-invariants.md` (the register
   is a contract; `docs/threat-model.md` says how). Run the review again.
2. A false positive: say so in the pull request body under "Security review",
   with the finding and the rule in `false-positives.md` or the precedent in
   `docs/threat-model.md` it matches. When the same false positive will come
   back for every pull request, add a rule to `false-positives.md` in the
   same pull request, as its own commit, worded for the class and not for the
   one finding.
3. Never edit the rules to make one pull request pass, and never run the
   review with permissions widened: the script restricts the tools on
   purpose, and the model needs nothing more than reading to review.
