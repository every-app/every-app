/**
 * Shell stubs for the tools a coding agent might reach Cloudflare with
 * (`cf`, `wrangler`): put first on the child's PATH, each logs every call
 * to the run's `other-commands.log` and refuses it, except what the
 * harness says it answers: `--version` with a pinned string, a command
 * prefix with a JSON document (`answers`, from the scenario's state), or a
 * command prefix handed to the real binary (`passthrough`: `cf workers
 * types` in the build harness, which only writes the app's types).
 */
import fs from "node:fs";

/**
 * Writes `file` as an executable `#!/bin/sh` stub for `tool`.
 *   logFile      where each call is appended as `<utc> <tool> <args>`
 *   version      what `<tool> --version` prints (optional)
 *   answers      [[commandPrefix, jsonValue], …]: `case "$*"` matches on the prefix (optional)
 *   passthrough  { prefixes: [commandPrefix, …], exec: absolutePath }: exec'd with the same arguments (optional)
 *   refusal      the stderr line for anything else (exit 1)
 */
export function writeShellStub(file, { tool, logFile, version = null, answers = [], passthrough = null, refusal }) {
  const cases = [];
  for (const [command, answer] of answers) {
    cases.push(`  "${command}"|"${command} "*)`, `    cat <<'STUB_JSON'`, JSON.stringify(answer, null, 2), "STUB_JSON", "    exit 0;;");
  }
  for (const command of passthrough?.prefixes ?? []) {
    cases.push(`  "${command}"|"${command} "*)`, `    exec ${JSON.stringify(passthrough.exec)} "$@";;`);
  }
  fs.writeFileSync(
    file,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$(date -u +%FT%TZ) ${tool} $*" >> ${JSON.stringify(logFile)}`,
      ...(version ? [`[ "$1" = "--version" ] && { echo "${version}"; exit 0; }`] : []),
      ...(cases.length ? ['case "$*" in', ...cases, "esac"] : []),
      // Double-quoted, so a `$*` in the refusal names the call.
      `echo ${JSON.stringify(refusal)} >&2`,
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}
