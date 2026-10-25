/**
 * `everyapp events add <url>` and `everyapp events add --email
 * owners|admins`: a subscription, written in the Gateway's D1 under the
 * Cloudflare login (lib/gateway/events.ts). Everything a person typed is
 * checked before anything is written, and the URL against the Gateway's
 * target rules (lib/gateway/eventTarget.ts), with the Gateway's host and
 * apps' domain from the install row and EVENTS_ALLOW_PRIVATE_TARGETS from
 * the names of the Gateway Worker's settings (its value can't be read
 * back; the Gateway checks it is "true" before every attempt).
 *
 * A webhook is always signed. Its secret comes from `--secret` (a hidden
 * prompt at a terminal, what is piped in, or `--secret-from-env VAR`, as
 * `secret set` reads a value; never the command line), or the CLI makes
 * one and shows it once: on the person's screen with "Copy it now", and
 * under --json only in `done.data.secret`, never in a message.
 */
import { text as readAll } from "node:stream/consumers";
import { GATEWAY_WORKER_NAME } from "@every-app/perimeter/manifest";
import { EVENTS_ALLOW_PRIVATE_TARGETS_SETTING, type EventEmailRecipients } from "@every-app/sdk/internal";
import chalk from "chalk";
import { listWorkerSecrets } from "@/lib/cf/secrets";
import { EveryAppError } from "@/lib/errors";
import { defaultTargetName } from "@/lib/gateway/eventTarget";
import {
  addSubscription,
  checkedSecret,
  eventPatterns,
  generatedSecret,
  subscriptionName,
  webhookUrl,
  type SubscriptionTarget,
} from "@/lib/gateway/events";
import { CLI } from "@/lib/output/command";
import { askSecret, canPromptInTerminal } from "@/lib/output/prompt";
import { formatFacts } from "@/lib/output/table";
import {
  connect,
  named,
  organizationData,
  patternsLabel,
  subscriptionData,
  targetOf,
  type EventsFlags,
  type EventsOptions,
} from "./shared";

export interface AddFlags extends EventsFlags {
  events?: string[];
  name?: string;
  email?: EventEmailRecipients;
  secret?: boolean;
  "secret-from-env"?: string;
}

/** Where `--secret` reads the value; tests answer for stdin, the prompt and the environment. */
interface SecretSources {
  /** What was piped in, or null when stdin is a terminal (default: stdin). */
  readStdin?: () => Promise<string | null>;
  /** The hidden prompt (default: lib/output/prompt.ts's, at a terminal). */
  prompt?: () => Promise<string>;
  /** Whether a person is at the terminal (default: canPromptInTerminal). */
  interactive?: boolean;
  env?: NodeJS.ProcessEnv;
}

export type AddOptions = EventsOptions<AddFlags> & SecretSources;

const STEP = "events.add";

const URL_SHAPE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** stdin's text when something is piped in; null at a terminal, where nothing will come. */
async function readPipedStdin(): Promise<string | null> {
  return process.stdin.isTTY ? null : readAll(process.stdin);
}

/**
 * The signing secret `--secret` stands for: from `--secret-from-env VAR`,
 * else what is piped in (its trailing newline dropped), else a hidden
 * prompt at a terminal; refused where none of those can give one.
 */
async function readSigningSecret(options: AddOptions): Promise<string> {
  const variable = options.flags["secret-from-env"];
  if (variable) {
    const value = (options.env ?? process.env)[variable];
    if (!value) {
      throw new EveryAppError("SECRET_EMPTY", `$${variable} is empty or not set`, {
        fix: `export ${variable} first, or name another variable with --secret-from-env`,
      });
    }
    return value;
  }
  const piped = await (options.readStdin ?? readPipedStdin)();
  if (piped !== null) {
    const value = piped.replace(/\r?\n$/, "");
    if (value) return value;
  }
  const interactive = options.interactive ?? canPromptInTerminal(options.flags.json ?? false);
  if (piped !== null || !interactive) {
    throw new EveryAppError(
      "SECRET_VALUE_REQUIRED",
      "Can't ask for the signing secret without a terminal\nPipe it in, or name the environment variable holding it with --secret-from-env.",
      { fix: "leave --secret out to have one made, or add --secret-from-env <VAR>" },
    );
  }
  return (
    options.prompt ??
    (() =>
      askSecret("Signing secret", {
        context: ["16 to 128 printable characters. Receivers check X-EveryApp-Signature with it."],
      }))
  )();
}

/** `events add`: the arguments, then the Gateway, then the row, one `done`. */
export async function addEvents(options: AddOptions, url?: string): Promise<void> {
  const { flags, out } = options;
  const wantsSecret = flags.secret === true || flags["secret-from-env"] !== undefined;
  // What a person typed first: no login, no network. A value typed after
  // --secret (`--secret abc`) lands here as the URL: refused unshown.
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
    throw new EveryAppError(
      "EVENT_SINK_CONFLICT",
      "Name where events go: a webhook URL, or --email owners|admins",
      { rerun: `${CLI} events add https://hooks.example.com/everyapp`, rerunNote: "or --email admins" },
    );
  }
  const events = eventPatterns(flags.events);
  const name = subscriptionName(flags.name);

  const { gateway, organization } = await connect(options);
  // Names only: whether a setting is there, never its value.
  const settings = await listWorkerSecrets(gateway.cf, GATEWAY_WORKER_NAME);
  let target: SubscriptionTarget;
  let secretGenerated = false;
  if (url !== undefined) {
    const stored = webhookUrl(url, {
      gatewayHost: gateway.install.gatewayHost,
      appBaseDomain: gateway.install.appBaseDomain,
      allowPrivate: settings.includes(EVENTS_ALLOW_PRIVATE_TARGETS_SETTING),
    });
    // The URL first, so a refused one costs no typed secret.
    const secret = wantsSecret ? checkedSecret(await readSigningSecret(options)) : generatedSecret();
    secretGenerated = !wantsSecret;
    target = { sink: "webhook", url: stored, secret };
  } else {
    target = { sink: "email", recipients: flags.email! };
    if (!settings.includes("EMAIL_FROM")) {
      out.emit({
        type: "warning",
        code: "EVENT_EMAIL_NOT_CONFIGURED",
        step: STEP,
        message:
          "The Gateway has no sender (EMAIL_FROM), so these mails can't go out yet\nEach one is dead at once with email_not_configured until a sender is set.",
        data: { rerun: `${CLI} secret set EMAIL_FROM EMAIL_FROM_NAME` },
      });
    }
  }

  out.emit({ type: "step", step: STEP, status: "start", message: "Adding the subscription..." });
  const subscription = await addSubscription(gateway.db, {
    organization,
    name:
      name ??
      (target.sink === "webhook"
        ? defaultTargetName(target.url)
        : target.recipients === "owners"
          ? "Email owners"
          : "Email owners and admins"),
    events,
    target,
    deployer: gateway.deployer,
    now: options.now?.(),
  });
  out.emit({
    type: "step",
    step: STEP,
    status: "ok",
    message: `Added ${named(subscription)}`,
    data: { id: subscription.id },
  });

  const test = `${CLI} events test ${subscription.id}`;
  const headline = `Added ${named(subscription)} for ${organization.name}.`;
  const facts = formatFacts([
    { label: "Events", value: patternsLabel(subscription.events) },
    { label: "Target", value: targetOf(subscription) },
    ...(target.sink === "webhook" && secretGenerated ? [{ label: "Secret", value: target.secret }] : []),
  ]);
  const notes = [
    ...(target.sink === "webhook"
      ? [
          secretGenerated
            ? "Copy it now: it isn't shown again. Each delivery is signed with it (X-EveryApp-Signature); the receiver checks it."
            : "Each delivery is signed with your secret (X-EveryApp-Signature); the receiver checks it.",
        ]
      : []),
    "The Gateway delivers within a minute of each event.",
  ];
  out.emit({
    type: "done",
    // Never the secret: a script reads it from data.secret.
    message: `${headline} ${notes.at(-1)}`,
    display: [headline, ...facts, ...notes.map((note) => chalk.dim(note))].join("\n"),
    data: {
      subscription: subscriptionData(subscription),
      organization: organizationData(organization),
      secretGenerated,
      ...(target.sink === "webhook" && secretGenerated ? { secret: target.secret } : {}),
      next: [{ command: test, note: "sends a test event and waits for the delivery" }],
    },
  });
}
