/**
 * Harness #0, `script` (design 4.4 row 1, build spec item 5): a bash script
 * that follows the prompt literally, with no model in the loop. It is the
 * control: the plumbing smoke test after every wipe and every CLI commit,
 * the per-account baseline for install, build, certificate and deploy
 * durations, and the reference that tells infra from a defect at n=1.
 *
 * The script prints `LOOP_CMD <command>` before each command it runs and
 * `LOOP_EXIT <code>` after, so the normalizer can turn them into tool_call
 * and tool_result events; the CLI's own NDJSON passes through untouched
 * (the event log is the source of truth for it) and is teed to
 * /loop/setup.ndjson etc. for the record. `setup` is rerun on exit 2 up to
 * four times, 20 seconds apart: the loop's claim lands while the first run
 * polls, so a rerun is normally only the one after
 * `register_workers_subdomain` on a fresh account, and the driver's REST PUT
 * plus its 10-second settle must be over before that rerun starts. It ends
 * with `DONE <gateway url>` or `BLOCKED: <why>`.
 */
import type {
  HarnessAdapter,
  HarnessCommand,
  HarnessLaunch,
  NormalizedEvent,
} from "../types";
import { event, parseJsonLine, splitCommand, str } from "./shared";

export const SCRIPT_PATH = "/loop/script.sh";

/** The control script. `{{ZONE}}` and `{{LOOP}}` are filled by scriptFor(); nothing else is templated. */
export const SCRIPT_TEMPLATE = `#!/usr/bin/env bash
# The onboarding loop's control: the setup prompt, followed literally.
set -u
ZONE="{{ZONE}}"
LOOP="{{LOOP}}"
cd /work/every-app || { echo "BLOCKED: no checkout at /work/every-app"; exit 1; }

run() {
  echo "LOOP_CMD $*"
  "$@"
  local code=$?
  echo "LOOP_EXIT $code"
  return $code
}

# JSON helpers: the last event of a type in an NDJSON file, one field of it.
last_event() { grep -F "\\"type\\":\\"$2\\"" "$1" | tail -n 1; }
field() { node -e 'const e=JSON.parse(process.argv[1]);const p=process.argv[2].split(".");let v=e;for(const k of p)v=v?.[k];if(v!==undefined)console.log(String(v))' "$1" "$2"; }

run pnpm install || { echo "BLOCKED: pnpm install exited $?"; exit 1; }

# setup: exit 0 done, 2 stopped for a person (the loop claims the owner while
# the first run waits; a rerun is the prompt's own instruction), 1 an error.
# 20 seconds between reruns: the loop's workers.dev PUT and its 10-second
# settle happen after the stop appears in the event log, and a rerun before
# that hits the same stop and wastes an attempt.
for attempt in 1 2 3 4; do
  echo "LOOP_CMD pnpm everyapp setup --domain apps.$ZONE --json"
  pnpm everyapp setup --domain "apps.$ZONE" --json | tee -a "$LOOP/setup.ndjson"
  code=\${PIPESTATUS[0]}
  echo "LOOP_EXIT $code"
  if [ "$code" -eq 0 ]; then break; fi
  if [ "$code" -ne 2 ]; then echo "BLOCKED: setup exited $code"; exit 1; fi
  if [ "$attempt" -eq 4 ]; then echo "BLOCKED: setup stopped for a person four times"; exit 1; fi
  sleep 20
done

GATEWAY_URL=$(field "$(last_event "$LOOP/setup.ndjson" done)" data.gatewayUrl)

echo "LOOP_CMD pnpm everyapp create hello --json"
pnpm everyapp create hello --json | tee -a "$LOOP/create.ndjson"
code=\${PIPESTATUS[0]}
echo "LOOP_EXIT $code"
[ "$code" -eq 0 ] || { echo "BLOCKED: create exited $code"; exit 1; }

cd apps/hello || { echo "BLOCKED: apps/hello missing after create"; exit 1; }
echo "LOOP_CMD pnpm everyapp deploy --json"
pnpm everyapp deploy --json | tee -a "$LOOP/deploy.ndjson"
code=\${PIPESTATUS[0]}
echo "LOOP_EXIT $code"
[ "$code" -eq 0 ] || { echo "BLOCKED: deploy exited $code"; exit 1; }

APP_URL=$(field "$(last_event "$LOOP/deploy.ndjson" done)" data.url)
echo "App URL: $APP_URL"
echo "DONE $GATEWAY_URL"
`;

/** The script with the zone and loop directory filled in; written to /loop/script.sh by the driver. */
export function scriptFor(
  launch: Pick<HarnessLaunch, "zone" | "loopDir">,
): string {
  const zone = launch.zone;
  if (!zone || !/^[a-z0-9.-]+$/i.test(zone)) {
    throw new Error(
      "the script harness needs the account's zone (letters, digits, dots and dashes)",
    );
  }
  const loopDir = launch.loopDir ?? "/loop";
  if (!/^\/[A-Za-z0-9_./-]*$/.test(loopDir))
    throw new Error("loopDir must be an absolute plain path");
  return SCRIPT_TEMPLATE.replaceAll("{{ZONE}}", zone).replaceAll(
    "{{LOOP}}",
    loopDir,
  );
}

export function createScriptAdapter(): HarnessAdapter {
  let sawResult = false;
  return {
    name: "script",
    version: "bash",
    status: "control",
    providerVar: null,
    defaultModel: null,
    signal: {
      toolCalls: "full",
      toolOutput: "full",
      exitCodes: true,
      cost: "none",
      resume: "none",
    },
    permissionBypass: true,
    command(launch): HarnessCommand {
      return {
        argv: ["bash", `${launch.loopDir ?? "/loop"}/script.sh`],
        env: {},
      };
    },
    resume(): HarnessCommand | null {
      return null;
    },
    normalize(line, stream, receivedAt): NormalizedEvent[] {
      const text = line.replace(/\r$/, "");
      if (text.trim() === "") return [];
      const cmd = /^LOOP_CMD (.+)$/.exec(text);
      if (cmd) {
        return [
          event("tool_call", receivedAt, text, {
            tool: "bash",
            argv: splitCommand(cmd[1]!),
            text: cmd[1],
          }),
        ];
      }
      const exit = /^LOOP_EXIT (\d+)$/.exec(text);
      if (exit) {
        const code = Number(exit[1]);
        return [
          event("tool_result", receivedAt, text, {
            tool: "bash",
            isError: code !== 0,
            text: `exit ${code}`,
          }),
        ];
      }
      const done = /^DONE\s+(\S+)/.exec(text);
      if (done) {
        sawResult = true;
        return [
          event("result", receivedAt, text, { text, stopReason: "done" }),
        ];
      }
      if (/^BLOCKED:/.test(text)) {
        sawResult = true;
        return [
          event("result", receivedAt, text, {
            text,
            isError: true,
            stopReason: "blocked",
          }),
        ];
      }
      // The CLI's own events pass through: the event log carries them.
      const json = parseJsonLine(text);
      if (json && json["v"] === 1 && str(json["type"])) return [];
      return [
        event("assistant_text", receivedAt, text, {
          text,
          isError: stream === "stderr" ? true : undefined,
        }),
      ];
    },
    onExit(exitCode, receivedAt): NormalizedEvent[] {
      if (sawResult) return [];
      return [
        event(
          "result",
          receivedAt,
          { synthesized: "process_exit", exitCode },
          {
            isError: exitCode !== 0,
            // Never the words DONE or BLOCKED here: the scripted user parses result text for them.
            text: `script exited ${exitCode ?? "by signal"} before its final line`,
            stopReason: "process_exit",
          },
        ),
      ];
    },
    collectPaths: [],
    fixture: null,
  };
}
