/**
 * What the `everyapp gateway …` commands share: output, Cloudflare login
 * and account, the remembered install, and the release to deploy.
 */
import path from "node:path";
import { version as cliVersion } from "../../../package.json";
import { runLogged } from "@/lib/childLog";
import { ensureCfAuth, resolveAccount } from "@/lib/cf/account";
import { canPromptInTerminal } from "@/lib/cf/deploy";
import { createCfRunner, type CfRunner } from "@/lib/cf/runner";
import { checkoutRoot } from "@/lib/checkout";
import {
  openRelease,
  RELEASE_TARBALL,
  type GatewayRelease,
} from "@/lib/gateway/release";
import {
  listCachedInstalls,
  readCachedInstall,
  type CachedInstall,
} from "@/lib/install/state";
import type { EventSink } from "@/lib/output/events";

export { eventSink, runReported } from "@/lib/output/run";
export { cliVersion };

interface Connected {
  cf: CfRunner;
  account: { id: string; name: string | null };
}

/** Log in to Cloudflare if needed, pick the account, and pin cf to it. */
export async function connectToAccount({
  json,
  accountId,
  remembered,
}: {
  json?: boolean;
  accountId?: string;
  remembered?: string;
}): Promise<Connected> {
  const interactive = canPromptInTerminal(json ?? false);
  const whoami = await ensureCfAuth({ cf: createCfRunner(), interactive });
  const account = await resolveAccount({
    whoami,
    flag: accountId,
    remembered,
    interactive,
  });
  return { cf: createCfRunner({ accountId: account.id }), account };
}

/** The gateway this machine deployed: for `domain`, or the only one. */
export async function rememberedInstall(
  domain?: string,
): Promise<CachedInstall | null> {
  if (domain) return readCachedInstall(domain);
  const installs = await listCachedInstalls();
  return installs.length === 1 ? installs[0]! : null;
}

/**
 * The gateway release to deploy: `--release <tarball>`, or one built from
 * the checkout this CLI runs from. Nothing is published while we work from
 * the repository, so there is no release bundled with the CLI.
 */
export async function openGatewayRelease({
  releasePath,
  out,
  verbose,
}: {
  releasePath?: string;
  out: EventSink;
  /** Stream the build's output to stderr too. */
  verbose?: boolean;
}): Promise<GatewayRelease> {
  if (releasePath) return openRelease(path.resolve(releasePath));
  return openRelease(await buildReleaseFromCheckout(out, verbose ?? false));
}

/** The release build's output goes to a log file (lib/childLog.ts). */
async function buildReleaseFromCheckout(
  out: EventSink,
  verbose: boolean,
): Promise<string> {
  const root = checkoutRoot();
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
