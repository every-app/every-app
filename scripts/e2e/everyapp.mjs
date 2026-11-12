/**
 * Run a checkout's own `everyapp` with --json: its launcher rebuilds the CLI
 * from that checkout's sources, so a run tests the code in that checkout.
 * Each command sees only this machine's e2e token and account, and its
 * events and stderr are kept in the run's folder.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

/**
 * What a command sees: the e2e token and account, and nothing that could aim
 * it at another Gateway (EVERYAPP_GATEWAY_URL, EVERYAPP_TOKEN) or keep setup
 * from showing the owner link (CI).
 */
export function childEnv(config) {
  const env = {
    ...process.env,
    CLOUDFLARE_API_TOKEN: config.token,
    CLOUDFLARE_ACCOUNT_ID: config.accountId,
  };
  for (const name of ["EVERYAPP_GATEWAY_URL", "EVERYAPP_TOKEN", "CI"]) delete env[name];
  return env;
}

/** The owner link's secret stays out of the logs. */
const redact = (text) => text.replace(/#token=est_[\w-]+/g, "#token=est_…");

const firstLine = (text) => String(text ?? "").split("\n")[0];

/** Events worth a line on the terminal while a command runs. */
function progress(event) {
  if (!firstLine(event.message)) return null;
  if (event.type === "step" && event.status === "ok") return `  ✓ ${firstLine(event.message)}`;
  if (event.type === "warning") return `  ! ${firstLine(event.message)}`;
  if (event.type === "action_required") return `  → ${firstLine(event.message)}`;
  return null;
}

/**
 * Run `everyapp <args> --json` in `cwd`, with `env` added to what it sees (a
 * provider's client, for `provider add --from-env`). `onEvent` sees each
 * event as it arrives (setup's owner link, say). Throws when the command
 * fails; returns its final `done` event, or null.
 */
export async function everyapp({ config, cwd, args, log, onEvent, env = {} }) {
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const file = fs.createWriteStream(log, { flags: "a" });
  file.write(`$ everyapp ${args.join(" ")} --json   (in ${cwd})\n`);
  const child = spawn("pnpm", ["exec", "everyapp", ...args, "--json"], {
    cwd,
    env: { ...childEnv(config), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise((resolve) => child.on("close", resolve));
  child.stderr.on("data", (chunk) => file.write(redact(String(chunk))));
  const events = [];
  for await (const line of readline.createInterface({ input: child.stdout })) {
    file.write(`${redact(line)}\n`);
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    events.push(event);
    const said = progress(event);
    if (said) console.log(said);
    await onEvent?.(event);
  }
  const code = await closed;
  await new Promise((resolve) => file.end(resolve));
  if (code !== 0) {
    const failure = events.findLast((event) => event.type === "error" || event.type === "action_required");
    throw new Error(
      `everyapp ${args[0]} exited ${code}${failure ? `: ${firstLine(failure.message)}` : ""}\nLog: ${log}`,
    );
  }
  return events.findLast((event) => event.type === "done") ?? null;
}
