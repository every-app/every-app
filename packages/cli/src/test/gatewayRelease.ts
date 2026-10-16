/**
 * A gateway release for tests, packed by the gateway's own release builder
 * from the worker.config.json `cf build` wrote for the gateway (a committed
 * fixture) and the gateway's real migrations.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CheckoutSource } from "@/lib/gateway/checkoutRelease";
import { openRelease } from "@/lib/gateway/release";
import { GATEWAY_MIGRATIONS_DIR } from "./sqliteD1";

const BUILDER = "../../../../apps/every-app-gateway/scripts/build-release.ts";
const WORKER_CONFIG_FIXTURE = fileURLToPath(
  new URL("../lib/gateway/__fixtures__/gateway-worker.config.json", import.meta.url),
);

interface Builder {
  stageRelease(options: {
    gatewayDir: string;
    stageDir: string;
    build: Record<string, string>;
  }): { sha256: string };
}

export async function buildGatewayRelease({
  version = "0.2.0",
  builtAt = "2026-10-12T00:00:00.000Z",
  extraMigration,
}: {
  version?: string;
  /** Two builds of one version differ by it. */
  builtAt?: string;
  /** Appended after the real migrations, e.g. one that fails. */
  extraMigration?: { file: string; sql: string };
} = {}): Promise<string> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-release-"));
  const source = path.join(work, "gateway");
  const worker = path.join(source, ".cloudflare/output/v0/workers/default");
  fs.mkdirSync(path.join(worker, "bundle"), { recursive: true });
  fs.writeFileSync(
    path.join(source, ".cloudflare/output/v0/config.json"),
    JSON.stringify({ buildContext: { isPreview: false, mode: "production" } }),
  );
  fs.copyFileSync(WORKER_CONFIG_FIXTURE, path.join(worker, "worker.config.json"));
  fs.writeFileSync(
    path.join(worker, "bundle/index.js"),
    `export {} // ${version} built ${builtAt}`,
  );
  fs.writeFileSync(path.join(worker, "bundle/index.js.map"), "{}");
  fs.cpSync(GATEWAY_MIGRATIONS_DIR, path.join(source, "drizzle"), {
    recursive: true,
  });
  if (extraMigration) {
    fs.writeFileSync(
      path.join(source, "drizzle", extraMigration.file),
      extraMigration.sql,
    );
  }

  const builder = (await import(/* @vite-ignore */ BUILDER)) as Builder;
  const stageDir = path.join(work, "stage");
  builder.stageRelease({
    gatewayDir: source,
    stageDir,
    build: {
      version,
      gitSha: "test",
      builtAt,
      cfVersion: "1.0.0-beta.14",
      pluginVersion: "2.0.0-beta.sha-91c870c02",
      configVersion: "0.24.1",
      minCli: "0.3.0",
      minSdk: "0.3.0",
    },
  });
  const tarball = path.join(work, "every-app-gateway-release.tar.gz");
  execFileSync("tar", ["-czf", tarball, "-C", stageDir, "."]);
  return tarball;
}

/**
 * What a checkout that builds this release says of itself without
 * building it (lib/gateway/checkoutRelease.ts `checkoutSource`): no tree
 * hash, ordered by the release's build time.
 */
export async function releaseSource(tarball: string): Promise<CheckoutSource> {
  const release = await openRelease(tarball);
  try {
    return { ...release.source, version: release.manifest.version };
  } finally {
    await release.cleanup();
  }
}
