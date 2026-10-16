/**
 * What the `everyapp gateway …` commands share: output, the Gateway they
 * act on (found through the Cloudflare login), and the release to deploy.
 */
import path from "node:path";
import { version as cliVersion } from "../../../package.json";
import { runLogged } from "@/lib/childLog";
import { deviceLoginAction } from "@/lib/cf/account";
import { canPromptInTerminal } from "@/lib/cf/deploy";
import type { CfRunner } from "@/lib/cf/runner";
import { checkoutRoot } from "@/lib/checkout";
import { loginAndDiscover, requireInstall } from "@/lib/gateway/connect";
import {
  requireGateway,
  type FoundGateway,
} from "@/lib/gateway/discover";
import { openCheckoutRelease } from "@/lib/gateway/checkoutRelease";
import type { InstallRecord } from "@/lib/gateway/install";
import { RELEASE_TARBALL, type GatewayRelease } from "@/lib/gateway/release";
import type { EventSink } from "@/lib/output/events";

export { eventSink, runReported } from "@/lib/output/run";
export { cliVersion };

interface ExistingGatewayOptions {
  /** --json: with `out`, cf's device login goes to the agent, and the run waits. */
  json?: boolean;
  out?: EventSink;
  accountId?: string;
  /** cf per account (tests). */
  createCf?: (accountId?: string) => CfRunner;
}

/**
 * The Gateway a command that needs one acts on, found through the
 * Cloudflare login (GATEWAY_NOT_FOUND when there is none); with
 * `installed`, one whose install is recorded and live.
 */
export async function existingGateway(
  options: ExistingGatewayOptions & { installed: true },
): Promise<FoundGateway & { install: InstallRecord }>;
export async function existingGateway(
  options: ExistingGatewayOptions & { installed?: false },
): Promise<FoundGateway>;
export async function existingGateway({
  json,
  out,
  accountId,
  createCf,
  installed,
}: ExistingGatewayOptions & { installed?: boolean }): Promise<FoundGateway> {
  const { whoami, discovery } = await loginAndDiscover({
    createCf,
    accountId,
    interactive: canPromptInTerminal(json ?? false),
    onDeviceLogin: json && out ? deviceLoginAction(out, "gateway.login") : undefined,
  });
  const gateway = requireGateway(discovery, whoami);
  return installed ? requireInstall(gateway) : gateway;
}

/**
 * The gateway release to deploy: the one this checkout builds, from the
 * build cache when its sources haven't changed since
 * (lib/gateway/checkoutRelease.ts). Nothing is published while we work
 * from the repository, so there is no other release to deploy.
 */
export function openGatewayRelease({
  out,
  verbose,
}: {
  out: EventSink;
  /** Stream the build's output to stderr too. */
  verbose?: boolean;
}): Promise<GatewayRelease> {
  const root = checkoutRoot();
  return openCheckoutRelease({
    root,
    out,
    build: () => buildReleaseFromCheckout(root, out, verbose ?? false),
  });
}

/**
 * The only source of the Gateway's code: the SDK's build, then the
 * Gateway's `build:release`. Their output goes to a log file
 * (lib/childLog.ts).
 */
async function buildReleaseFromCheckout(
  root: string,
  out: EventSink,
  verbose: boolean,
): Promise<string> {
  const gatewayDir = path.join(root, "apps", "every-app-gateway");
  out.emit({
    type: "progress",
    step: "gateway.release",
    message: "Building the Gateway from this checkout (a minute or two)...",
    data: { dir: gatewayDir },
  });
  const build = (args: string[], cwd: string) =>
    runLogged("pnpm", args, {
      cwd,
      echo: verbose,
      what: "Building the Gateway",
      code: "GATEWAY_BUILD_FAILED",
    });
  // The gateway build resolves @every-app/sdk from its dist/.
  await build(["--filter", "@every-app/sdk", "build"], root);
  await build(["run", "build:release"], gatewayDir);
  return path.join(gatewayDir, RELEASE_TARBALL);
}
