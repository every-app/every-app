import { cfWhoami, deviceLoginAction, logIn } from "@/lib/cf/account";
import { EveryAppError } from "@/lib/errors";
import { signInToGateway, signOutOfGateway } from "@/lib/gatewayApi";
import { gatewayOrigin } from "@/lib/linkedDev";
import { canPromptInTerminal } from "@/lib/output/prompt";
import { createCfRunner, type CfRunner } from "@/lib/cf/runner";
import type { EventSink } from "@/lib/output/events";
import { runCommand } from "@/lib/output/run";

const STEP = "cloudflare.login";

interface LoginCommandFlags {
  gateway?: string;
  "sign-out"?: boolean;
  json?: boolean;
  verbose?: boolean;
}

/**
 * `everyapp login`: log cf in to Cloudflare, and say as whom.
 * `everyapp login --gateway <url>`: sign in to that Gateway's admin API
 * (lib/gatewayApi), or with `--sign-out` revoke and forget the sign-in.
 */
export async function login(flags: LoginCommandFlags,
): Promise<void> {
  await runCommand(flags, async (out) => {
    if (flags["sign-out"] && !flags.gateway) {
      throw new EveryAppError("INVALID_VALUE", "--sign-out needs --gateway <url>: which Gateway to sign out of");
    }
    if (flags.gateway) {
      const gateway = gatewayOrigin(flags.gateway);
      if (flags["sign-out"]) {
        const signedOut = await signOutOfGateway(gateway);
        out.emit({
          type: "done",
          message: signedOut
            ? `Signed out of ${gateway}${signedOut.revoked ? "" : " (forgotten here; revoke it under Connections there)"}.`
            : `Not signed in to ${gateway}.`,
          data: { gateway, signedIn: false, revoked: signedOut?.revoked ?? false },
        });
        return;
      }
      await signInToGateway(gateway, { out, json: flags.json });
      out.emit({ type: "done", data: { gateway, signedIn: true } });
      return;
    }
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
