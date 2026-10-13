/**
 * What the `everyapp gateway …` commands share: output, Cloudflare login
 * and account, the remembered install, and the release to deploy.
 */
import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { version as cliVersion } from "../../../package.json";
import { ensureCfAuth, resolveAccount } from "@/lib/cf/account";
import { canPromptInTerminal } from "@/lib/cf/deploy";
import { createCfRunner, type CfRunner } from "@/lib/cf/runner";
import { EveryAppError } from "@/lib/errors";
import {
  bundledReleaseTarball,
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

/** `https://apps.example.com/` → `apps.example.com`. */
export function normalizeDomain(domain: string | undefined): string | undefined {
  return domain
    ?.trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}

/**
 * The gateway release to deploy: `--release <tarball>`, the one bundled with
 * this CLI, or, inside the Every App monorepo, one built from source.
 */
export async function openGatewayRelease({
  releasePath,
  out,
}: {
  releasePath?: string;
  out: EventSink;
}): Promise<GatewayRelease> {
  if (releasePath) return openRelease(path.resolve(releasePath));
  const bundled = bundledReleaseTarball();
  if (bundled) return openRelease(bundled);
  return openRelease(await buildReleaseFromSource(out));
}

/** Walk up from the working directory to apps/every-app-gateway. */
function findGatewaySource(startDir: string): string | null {
  for (let dir = path.resolve(startDir); ; dir = path.dirname(dir)) {
    const gateway = path.join(dir, "apps", "every-app-gateway");
    if (fs.existsSync(path.join(gateway, "scripts", "build-release.ts"))) {
      return gateway;
    }
    if (path.dirname(dir) === dir) return null;
  }
}

async function buildReleaseFromSource(out: EventSink): Promise<string> {
  const gatewayDir = findGatewaySource(process.cwd());
  if (!gatewayDir) {
    throw new EveryAppError(
      "RELEASE_MISSING",
      "This everyapp has no bundled gateway release. Install the published CLI (npx everyapp@latest), run it from inside the Every App repository, or pass --release <tarball>.",
    );
  }
  out.emit({
    type: "progress",
    step: "gateway.release",
    message: "Building the gateway release from source...",
  });
  const repoRoot = path.resolve(gatewayDir, "..", "..");
  // The gateway build resolves @every-app/sdk from its dist/.
  await execa("pnpm", ["--filter", "@every-app/sdk", "build"], {
    cwd: repoRoot,
  });
  await execa("pnpm", ["run", "build:release"], { cwd: gatewayDir });
  return path.join(gatewayDir, RELEASE_TARBALL);
}
