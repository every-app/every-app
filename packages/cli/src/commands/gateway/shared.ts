/**
 * What the `everyapp gateway …` commands share: output, Cloudflare login
 * and account, the remembered install, and the release to deploy.
 */
import path from "node:path";
import { execa } from "execa";
import { version as cliVersion } from "../../../package.json";
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
}: {
  releasePath?: string;
  out: EventSink;
}): Promise<GatewayRelease> {
  if (releasePath) return openRelease(path.resolve(releasePath));
  return openRelease(await buildReleaseFromCheckout(out));
}

async function buildReleaseFromCheckout(out: EventSink): Promise<string> {
  const root = checkoutRoot();
  const gatewayDir = path.join(root, "apps", "every-app-gateway");
  out.emit({
    type: "progress",
    step: "gateway.release",
    message: `Building the gateway release from ${gatewayDir}...`,
  });
  // The gateway build resolves @every-app/sdk from its dist/.
  await execa("pnpm", ["--filter", "@every-app/sdk", "build"], { cwd: root });
  await execa("pnpm", ["run", "build:release"], { cwd: gatewayDir });
  return path.join(gatewayDir, RELEASE_TARBALL);
}
