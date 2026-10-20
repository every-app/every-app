import type { LocalContext } from "@/context";
import { cfWhoami, deviceLoginAction, logIn } from "@/lib/cf/account";
import { canPromptInTerminal } from "@/lib/output/prompt";
import { createCfRunner, type CfRunner } from "@/lib/cf/runner";
import type { EventSink } from "@/lib/output/events";
import { runCommand } from "@/lib/output/run";

const STEP = "cloudflare.login";

interface LoginCommandFlags {
  json?: boolean;
  verbose?: boolean;
}

/** `everyapp login`: log cf in to Cloudflare, and say as whom. */
export async function login(
  this: LocalContext,
  flags: LoginCommandFlags,
): Promise<void> {
  await runCommand(flags, async (out) => {
    await logInToCloudflare({ out, interactive: canPromptInTerminal(flags.json ?? false) });
    out.emit({ type: "done" });
  });
}

interface LogInToCloudflareOptions {
  out: EventSink;
  /** At a terminal, cf's own login; otherwise its device link and code, waited for. */
  interactive: boolean;
  cf?: CfRunner;
}

export async function logInToCloudflare({
  out,
  interactive,
  cf = createCfRunner(),
}: LogInToCloudflareOptions): Promise<void> {
  const before = await cfWhoami(cf);
  if (before.authenticated) {
    out.emit({
      type: "step",
      step: STEP,
      status: "skip",
      message: "Already logged in to Cloudflare.",
      data: {
        email: before.email ?? null,
        token: Boolean(process.env["CLOUDFLARE_API_TOKEN"]),
      },
    });
    return;
  }
  const whoami = await logIn({
    cf,
    interactive,
    onDeviceLogin: deviceLoginAction(out, STEP),
  });
  out.emit({
    type: "step",
    step: STEP,
    status: "ok",
    message: "Logged in to Cloudflare.",
    data: { email: whoami.email ?? null },
  });
}
