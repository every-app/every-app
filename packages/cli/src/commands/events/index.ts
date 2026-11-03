/**
 * `everyapp events …`: the organization's event subscriptions
 * (docs/design/2026-10-events-out.md), each command one Gateway tool
 * (`everyapp_workspace_events*`, `everyapp_workspace_event_*`) run as you
 * through the same EventSubscriptionService as Admin → Events
 * (lib/gatewayApi). `events types` is the catalogue the CLI ships with
 * (`EVENT_TYPES`), so it needs no Gateway.
 *
 * A webhook is always signed. Its secret comes from `--secret` (a hidden
 * prompt at a terminal, what is piped in, or `--secret-from-env VAR`, as
 * `secret set` reads a value; never the command line) and travels to the
 * Gateway in the tool's `secret` argument, or the Gateway makes one and
 * returns it once: on the person's screen with "Copy it now", and under
 * --json only in `done.data.secret`, never in a message.
 */
import { text as readAll } from "node:stream/consumers";
import { EVENT_TYPES, type EventEmailRecipients } from "@every-app/sdk/internal";
import chalk from "chalk";
import { EveryAppError } from "@/lib/errors";
import { formatAnswer, runTool, type ToolCommandFlags } from "@/lib/gatewayApi/command";
import type { JsonObject } from "@/lib/gatewayApi";
import type { EventSink } from "@/lib/output/events";
import { askSecret, canPromptInTerminal } from "@/lib/output/prompt";
import { runCommand } from "@/lib/output/run";
import { formatTable } from "@/lib/output/table";
import { plural } from "@/lib/output/text";

export interface AddFlags extends ToolCommandFlags {
  events?: string[];
  name?: string;
  email?: EventEmailRecipients;
  secret?: boolean;
  "secret-from-env"?: string;
}

/** Where `--secret` reads the value; tests answer for stdin, the prompt and the environment. */
export interface SecretSources {
  readStdin?: () => Promise<string | null>;
  prompt?: () => Promise<string>;
  interactive?: boolean;
  env?: NodeJS.ProcessEnv;
}

const URL_SHAPE = /^[a-z][a-z0-9+.-]*:\/\//i;
const str = (value: unknown) => (typeof value === "string" ? value : "");
const obj = (value: unknown): JsonObject => (value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {});

async function readPipedStdin(): Promise<string | null> {
  return process.stdin.isTTY ? null : readAll(process.stdin);
}

/**
 * The signing secret `--secret` stands for: from `--secret-from-env VAR`,
 * else what is piped in (its trailing newline dropped), else a hidden
 * prompt at a terminal; refused where none of those can give one.
 */
export async function readSigningSecret(flags: AddFlags, sources: SecretSources = {}): Promise<string> {
  const variable = flags["secret-from-env"];
  if (variable) {
    const value = (sources.env ?? process.env)[variable];
    if (!value) {
      throw new EveryAppError("SECRET_EMPTY", `$${variable} is empty or not set`, {
        fix: `export ${variable} first, or name another variable with --secret-from-env`,
      });
    }
    return value;
  }
  const piped = await (sources.readStdin ?? readPipedStdin)();
  if (piped !== null) {
    const value = piped.replace(/\r?\n$/, "");
    if (value) return value;
  }
  const interactive = sources.interactive ?? canPromptInTerminal(flags.json ?? false);
  if (piped !== null || !interactive) {
    throw new EveryAppError(
      "SECRET_VALUE_REQUIRED",
      "Can't ask for the signing secret without a terminal\nPipe it in, or name the environment variable holding it with --secret-from-env.",
      { fix: "leave --secret out to have one made, or add --secret-from-env <VAR>" },
    );
  }
  return (
    sources.prompt ??
    (() => askSecret("Signing secret", { context: ["16 to 128 printable characters. Receivers check X-EveryApp-Signature with it."] }))
  )();
}

/** `events add`'s arguments as `everyapp_workspace_events_add` takes them; what a person typed is checked first. */
export async function addArgs(flags: AddFlags, url: string | undefined, sources: SecretSources = {}): Promise<JsonObject> {
  const wantsSecret = flags.secret === true || flags["secret-from-env"] !== undefined;
  // A value typed after --secret (`--secret abc`) lands here as the URL: refused unshown.
  if (wantsSecret && url !== undefined && !URL_SHAPE.test(url.trim())) {
    throw new EveryAppError(
      "VALUE_ON_COMMAND_LINE",
      "--secret takes no value on the command line\nIt lands in the shell's history and the process list: rotate it if it was real. Nothing was added.",
      { fix: "give --secret alone: it asks at a hidden prompt, or reads the secret piped in or from --secret-from-env <VAR>" },
    );
  }
  if (url !== undefined && flags.email !== undefined) {
    throw new EveryAppError(
      "EVENT_SINK_CONFLICT",
      "Give a webhook URL or --email, not both\nA subscription delivers one way: a signed POST to a URL, or mail to the organization's owners (and admins).",
      { fix: "add one subscription for each" },
    );
  }
  if (flags.email !== undefined && wantsSecret) {
    throw new EveryAppError(
      "EVENT_SINK_CONFLICT",
      "An email subscription has no signing secret\nOnly a webhook is signed; mail goes from the Gateway's own sender to the organization's members.",
      { fix: "leave --secret out" },
    );
  }
  if (url === undefined && flags.email === undefined) {
    throw new EveryAppError("EVENT_TARGET_REQUIRED", "Where should the events go? Give a webhook's https:// URL, or --email owners|admins", {
      fix: "events add https://hooks.example.com/everyapp, or events add --email admins",
    });
  }
  const events = (flags.events ?? []).flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
  return {
    ...(url !== undefined ? { url: url.trim() } : {}),
    ...(flags.email !== undefined ? { email: flags.email } : {}),
    ...(events.length ? { events } : {}),
    ...(flags.name !== undefined ? { name: flags.name } : {}),
    ...(wantsSecret ? { secret: await readSigningSecret(flags, sources) } : {}),
  };
}

export async function add(flags: AddFlags, url?: string): Promise<void> {
  await runTool(flags, async () => {
    const args = await addArgs(flags, url);
    return {
      tool: "everyapp_workspace_events_add",
      args,
      done: (answer: JsonObject) => `Added ${str(obj(answer["subscription"])["name"]) || "the subscription"} (${str(obj(answer["subscription"])["id"])})`,
      display: (answer: JsonObject) => {
        const { secret, ...rest } = answer;
        return [
          formatAnswer(rest),
          ...(typeof secret === "string" && !args["secret"]
            ? ["", `${chalk.bold("Signing secret")} (shown once; copy it now): ${chalk.cyan(secret)}`]
            : []),
        ].join("\n");
      },
    };
  });
}

export const list = (flags: ToolCommandFlags) =>
  runTool(flags, {
    tool: "everyapp_workspace_events",
    done: (answer) => plural(Array.isArray(answer["subscriptions"]) ? answer["subscriptions"].length : 0, "subscription"),
  });

export const remove = (flags: ToolCommandFlags, subscription: string) =>
  runTool(flags, {
    tool: "everyapp_workspace_events_remove",
    args: { subscription, confirm: true },
    done: (answer) => (answer["disabled"] === true ? `${subscription} is built in: disabled instead` : `Removed ${subscription}`),
    display: () => "",
  });

const setEnabled = (flags: ToolCommandFlags, subscription: string, enabled: boolean) =>
  runTool(flags, {
    tool: "everyapp_workspace_events_set",
    args: { subscription, enabled },
    done: () => `${subscription} is ${enabled ? "on" : "paused"}`,
    display: () => "",
  });

export const enable = (flags: ToolCommandFlags, subscription: string) => setEnabled(flags, subscription, true);
export const disable = (flags: ToolCommandFlags, subscription: string) => setEnabled(flags, subscription, false);

export const test = (flags: ToolCommandFlags, subscription: string) =>
  runTool(flags, {
    tool: "everyapp_workspace_events_test",
    args: { subscription },
    done: (answer) => `Test event to ${subscription}: ${str(obj(answer["delivery"])["state"]) || "sent"}`,
  });

export const deliveries = (
  flags: ToolCommandFlags & { dead?: boolean; limit?: number; before?: string },
  subscription?: string,
) =>
  runTool(flags, {
    tool: "everyapp_workspace_event_deliveries",
    args: {
      ...(subscription ? { subscription } : {}),
      ...(flags.dead ? { dead: true } : {}),
      ...(flags.limit ? { limit: flags.limit } : {}),
      ...(flags.before ? { before: flags.before } : {}),
    },
    done: (answer) => plural(Array.isArray(answer["deliveries"]) ? answer["deliveries"].length : 0, "delivery"),
    display: (answer) =>
      [formatAnswer({ ...answer, nextBefore: undefined }), answer["nextBefore"] ? `More: --before ${String(answer["nextBefore"])}` : ""]
        .filter(Boolean)
        .join("\n\n"),
  });

export const redeliverDelivery = (flags: ToolCommandFlags, delivery: string) =>
  runTool(flags, {
    tool: "everyapp_workspace_event_redeliver",
    args: { delivery },
    done: (answer) => `Redelivered ${delivery}: ${str(obj(answer["delivery"])["state"]) || "sent again"}`,
  });

export async function types(flags: { json?: boolean; verbose?: boolean }): Promise<void> {
  await runCommand(flags, async (out) => listTypes(out));
}

function listTypes(out: EventSink): void {
  const notes = [
    "An app's own events are app.<app id>.<name> (app.crm.invoice.paid): subscribe with app.crm.* or app.*.",
    "--events takes types, prefixes with .* (member.*), or * for everything but test pings and subscription.* (the default).",
  ];
  out.emit({
    type: "done",
    message: plural(EVENT_TYPES.length, "event type"),
    display: [
      ...formatTable(
        ["TYPE", "V", "WHAT"],
        EVENT_TYPES.map((info) => [info.type, String(info.version), chalk.dim(info.description)]),
      ),
      "",
      ...notes.map((note) => chalk.dim(note)),
    ].join("\n"),
    data: {
      types: EVENT_TYPES.map((info) => ({ type: info.type, version: info.version, group: info.group, description: info.description })),
      patterns: ["*", "<group>.*", "app.<app id>.*", "app.<app id>.<name>"],
    },
  });
}
