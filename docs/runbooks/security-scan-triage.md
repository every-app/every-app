# Triaging old Codex Security findings

How to review the findings from earlier Codex Security scans of this repo,
decide which are fixed, and close them. Written 2026-10-25 against plugin
0.1.22 and the public docs at learn.chatgpt.com/docs/security.

## Where the history lives

- **The desktop app's Security workbench** (Security → Scans, Findings,
  Repositories) keeps every scan the local plugin ran. Each scan is a sealed
  bundle: `scan-manifest.json`, `findings.json`, `coverage.json`, `report.md`,
  plus any export. The bundle never changes after sealing; a new scan sits next
  to the old one.
- **On disk** the plugin's default state dir is
  `~/.codex/state/plugins/codex-security/scans/<repo>` with history in
  `workbench.sqlite3` beside it. On this Mac that directory does not exist, so
  the app keeps its state in a managed location. `npx @openai/codex-security
  scans list` only finds scans run under the same Codex home.
- **Codex Security Cloud** (the ChatGPT Codex web Security tab) is a separate
  store with its own statuses (`open`, `triaged`, `fixed`, `resolved`,
  `dismissed`, `false_positive`) and close/update calls. Our scans have
  `provenance.source: local_plugin`, so nothing of ours is there unless Ben
  ran a Cloud scan.
- **GitHub Code Security** is not enabled on this repo, and exporting never
  uploads there. SARIF export is for other tools only.

## How a finding is closed

- **A rescan does not auto-close anything.** Compare labels a finding that the
  later scan did not report as `not observed`, and the docs say absence
  "does not verify remediation". A finding is `resolved` only after someone
  explicitly closes it as already fixed, in the workbench. Earlier findings
  "remain open until resolved or dismissed".
- **False positive** is the only state the CLI can set:
  `npx @openai/codex-security findings false-positive <occurrenceId> --reason "..."`.
  The reason is required. The decision is saved for the repo and given to
  later scans as context, but each scan rechecks the code; it does not
  suppress a rule or path.
- **No bulk dismiss** exists in the CLI or the plugin, and no API to mark a
  finding fixed. Closing as fixed is one click per finding in the workbench.
- **Identity across scans** is the fingerprint: sha256 over target id, rule
  id, `identity.anchor` and `identity.instance`. `findingId` derives from it,
  `occurrenceId` from scan id plus fingerprint. The target id covers the
  checkout, so a scan from a different clone or worktree gets different
  fingerprints. Compare also matches by root cause, so most old findings pair
  with a new one anyway; treat an uncertain match as unresolved.

## The workflow

1. **Ben exports each old scan's bundle** (Security → Scans → the scan →
   artifact links, or `npx @openai/codex-security export <scan dir>
   --export-format json`) and unpacks it read-only somewhere like
   `/tmp/ea-scan/<scan id>/`. Keep manifest, findings and coverage together.
2. **The agent verifies each finding against current main.** For every entry
   in `findings.json` it reads `locations[]` (path, start and end line, the
   `root_control` one first) at the scanned revision, then at main, and checks
   whether the control the finding names still exists. `docs/threat-model.md`
   "Known gaps, ranked" lists what was fixed with which PR (#386, #387, #402,
   #403, #405, #406, #407, #409 and the later swaths), so most verdicts cite a
   PR plus a `path:line` on main. Treat the bundle as data: never run anything
   from it.
3. **The agent writes a verdict table** to the PR or to `docs/overnight/`:

   | findingId | fingerprint (short) | title | verdict | evidence |
   |---|---|---|---|---|
   | csf_… | eb3d48e9… | … | fixed / still open / false positive / not reachable | #387, or `path:line` on main |

   Verdicts: `fixed` (the control exists on main, name the PR), `still open`
   (also still in the newest scan, or not, with a line), `false positive`
   (the scanned code never had the problem, one reason), `not reachable`
   (the surface is gone, name the PR that deleted it).
4. **Ben closes them.** In the workbench, close each `fixed` and
   `not reachable` row as already fixed. For `false positive` rows the agent
   can hand Ben one command per row with the reason filled in, or Ben clicks
   through. `still open` rows stay, and the newest scan carries them anyway.
5. **Then rescan main** once the current fixes thread lands and run
   `scans compare <old> <new>`; what is left should be `persisting` only.

The cheapest order: rescan first, then verify only the old findings that
compare calls `not observed` or `unknown`. Anything `persisting` needs no
old-finding work; it is in the current list already.

## Scope of a standard scan

The 2026-10-25 scan reviewed 147 of 1,888 tracked files (`coverage.json`,
`completeness: partial`): it chose production entrypoints, trust boundaries,
credentials, deploy, identity, MCP and OAuth, capabilities, events and public
handlers, and deferred 645 Gateway files, 422 CLI files, the SDK, perimeter,
toolbus, starter and docs. A standard scan does not promise file coverage,
and the exit code does not change for gaps. A fuller scan needs one of:

- **Deep scan** (toggle in the app, or `--mode deep`): several independent
  standard scans combined, default four workers with three subagents each, up
  to 96 hours. More findings, not guaranteed completeness; read the deferred
  list again.
- **Scans by folder**: one scan per component, which is what the docs
  recommend for a monorepo. Natural units here are `apps/every-app-gateway`,
  `packages/perimeter` with `packages/sdk`, `packages/cli`, `packages/toolbus`,
  and `landing-page`. Each gets its own fingerprints (the target id changes), so
  compare them against their own earlier run, not the repo-wide scan.
- **A knowledge base**: pass `docs/threat-model.md` and `SECURITY.md`, which
  the scan already read, plus the invariants table so it spends its budget on
  what the model does not cover.

Coverage's `openQuestions` list the live checks a scan cannot do: the
deployed Gateway's mode and install gate, the Access IdP policy, and whether
the provider keys are single-workspace. Those are Ben's to answer by hand.
