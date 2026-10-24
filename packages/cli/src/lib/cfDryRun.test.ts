/**
 * `cf deploy --prebuilt --dry-run` with the real cf, of what everyapp
 * deploys: the gateway release, patched as for an install, and the starter
 * template, built tenant-neutral, installed and checked against the app
 * policy.
 * A dry run reads the Build Output and prints its bindings without any
 * Cloudflare account, credentials or network, so a cf or Vite plugin bump
 * that changes the Build Output fails here instead of in a live deploy.
 *
 * Skipped unless EVERYAPP_CF_DRY_RUN=1, after the SDK and the gateway
 * release are built (`pnpm -C apps/every-app-gateway build:release`), as
 * the cf-dry-run CI job does.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildApp } from "@/lib/app/buildApp";
import { installAppBuildOutput } from "@/lib/app/installBuildOutput";
import { prepareAppBuildOutput } from "@/lib/app/policy";
import { cfDeploy } from "@/lib/cf/deploy";
import { makeCfTempDir } from "@/lib/cf/privateDir";
import { createCfRunner } from "@/lib/cf/runner";
import { patchGatewayBuildOutput } from "@/lib/gateway/patchBuildOutput";
import { openRelease } from "@/lib/gateway/release";
import { newGatewaySecrets } from "@/lib/gateway/secretsFile";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const RELEASE = path.join(REPO, "apps/every-app-gateway/every-app-gateway-release.tar.gz");
const TEMPLATE = path.join(REPO, "starter");
// A stand-in account: a dry run never calls the API.
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const PUBLIC_KEY =
  "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n-----END PUBLIC KEY-----";

describe.runIf(process.env["EVERYAPP_CF_DRY_RUN"] === "1")(
  "cf deploy --prebuilt --dry-run",
  { timeout: 600_000 },
  () => {
    it("takes the gateway release, patched for an install", async () => {
      const release = await openRelease(RELEASE);
      const workdir = await makeCfTempDir("dry-run-gateway-");
      try {
        fs.cpSync(release.dir, workdir, { recursive: true });
        await patchGatewayBuildOutput(workdir, {
          d1Id: "11111111-2222-4333-8444-555555555555",
          oauthKvId: "0123456789abcdef0123456789abcdef",
          release: {
            version: release.manifest.version,
            sha256: release.manifest.sha256,
          },
          gatewayHost: "apps.example.com",
          appBaseDomain: "apps.example.com",
          appWorkers: ["every-acme-todo", "every-chef"],
          appHosts: ["todo.apps.example.com", "chef-globex.apps.example.com"],
        });

        const { output } = await cfDeploy({
          cf: createCfRunner({ accountId: ACCOUNT_ID }),
          cwd: workdir,
          workerName: "every-app-gateway",
          accountId: ACCOUNT_ID,
          message: "dry run",
          secrets: newGatewaySecrets({
            gatewayUrl: "https://apps.example.com",
            accountId: ACCOUNT_ID,
            deploymentMode: "self_hosted",
          }).secrets,
          interactive: false,
          attach: false,
          dryRun: true,
          cliCf: true,
        });

        for (const binding of [
          "env.DB (every-app-gateway)",
          "env.OAUTH_KV (0123456789abcdef0123456789abcdef)",
          "env.APP__every-acme-todo (every-acme-todo)",
          "env.APP__every-chef (every-chef)",
          "env.AUTH_RATE_LIMIT_ACCOUNT",
          "env.EVERYAPP_RELEASE",
          "env.APP_BASE_DOMAIN",
          "--dry-run: exiting now.",
        ]) {
          expect(output).toContain(binding);
        }
      } finally {
        await release.cleanup();
        fs.rmSync(workdir, { recursive: true, force: true });
      }
    });

    it("takes the starter template, built and installed", async () => {
      const cf = createCfRunner({ accountId: ACCOUNT_ID });
      const inputs = {
        workerName: "every-acme-simple-todo",
        organizationId: "org-1",
        gatewayUrl: "https://apps.example.com",
        identityPublicKeys: [PUBLIC_KEY],
        resources: {
          d1: {
            DB: {
              name: "every-acme-simple-todo",
              id: "11111111-2222-4333-8444-555555555555",
            },
          },
          kv: { KV: { id: "0123456789abcdef0123456789abcdef" } },
        },
      };

      await buildApp({ cwd: TEMPLATE, cf, verbose: false });
      await installAppBuildOutput({ cwd: TEMPLATE, target: inputs });
      await prepareAppBuildOutput({ cwd: TEMPLATE, inputs });
      const { output } = await cfDeploy({
        cf,
        cwd: TEMPLATE,
        workerName: inputs.workerName,
        accountId: ACCOUNT_ID,
        message: "dry run",
        secrets: { GATEWAY_URL: inputs.gatewayUrl, EVERY_APP_ORG_ID: "org-1" },
        interactive: false,
        attach: false,
        dryRun: true,
      });

      for (const binding of [
        "env.DB (every-acme-simple-todo)",
        "env.KV (0123456789abcdef0123456789abcdef)",
        "env.EVERY_APP_GATEWAY (every-app-gateway#AppGateway)",
        "--dry-run: exiting now.",
      ]) {
        expect(output).toContain(binding);
      }
      expect(output).not.toContain("sentinel");
    });
  },
);
