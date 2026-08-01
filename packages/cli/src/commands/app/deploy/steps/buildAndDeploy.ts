import chalk from "chalk";
import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { executeCommandWithFormatting } from "@/lib/formatting";
import { resolveLocalPackageBin } from "@/lib/local-package-bin";
import { formatCloudflareError } from "@/lib/cloudflare/errors";
import { exitWithUpdateNotice } from "@/lib/version-check";

interface BuildAndDeployOptions {
  cwd: string;
  buildCommand?: string;
  gatewayUrl: string;
  /** The unprefixed app ID (e.g., "todo-app") used to set VITE_APP_ID */
  appId: string;
  generatedWranglerConfigPath: string;
  verbose: boolean;
}

/**
 * Build and deploy the app to Cloudflare Workers
 */
export async function buildAndDeploy({
  cwd,
  buildCommand,
  gatewayUrl,
  appId,
  generatedWranglerConfigPath,
  verbose,
}: BuildAndDeployOptions): Promise<void> {
  const deployEnv = {
    ...process.env,
    VITE_GATEWAY_URL: gatewayUrl,
    VITE_APP_ID: appId,
    EVERYAPP_GATEWAY_URL: gatewayUrl,
    EVERYAPP_APP_ID: appId,
  };

  try {
    await removeStaleBuiltWranglerConfig(cwd);

    // A manifest-declared build command wins; otherwise auto-detect vite; a
    // plain worker with neither deploys the generated config directly.
    if (buildCommand) {
      await executeCommandWithFormatting(buildCommand, [], {
        cwd,
        description: "Building your application...\n",
        env: deployEnv,
        shell: true,
        verbose,
      });
    } else if (await hasViteConfig(cwd)) {
      await executeCommandWithFormatting("npx", ["vite", "build"], {
        cwd,
        description: "Building your application...\n",
        env: deployEnv,
        verbose,
      });
    } else if (verbose) {
      console.log(
        chalk.dim("No Vite config found; deploying generated worker config."),
      );
    }

    const wranglerConfigPath = await prepareDeployWranglerConfig({
      cwd,
      generatedWranglerConfigPath,
      verbose,
    });

    // Deploy to Cloudflare
    const { command, argsPrefix } = await resolveLocalPackageBin(
      cwd,
      "wrangler",
      "wrangler",
    );
    await executeCommandWithFormatting(
      command,
      [...argsPrefix, "deploy", "-c", wranglerConfigPath],
      {
        cwd,
        description:
          "Deploying your private application worker to Cloudflare...\n\n  This could take up to a minute.",
        env: deployEnv,
        verbose,
      },
    );
  } catch (error) {
    // Check if this is a known Cloudflare error with a user-friendly message
    const cloudflareError = await formatCloudflareError(error);
    if (cloudflareError) {
      console.log(cloudflareError.formatted);
      await exitWithUpdateNotice(1);
    }

    console.error(chalk.red("\nFailed to build or deploy"));
    throw error;
  }
}

interface PrepareDeployWranglerConfigOptions {
  cwd: string;
  generatedWranglerConfigPath: string;
  verbose: boolean;
}

async function prepareDeployWranglerConfig({
  cwd,
  generatedWranglerConfigPath,
  verbose,
}: PrepareDeployWranglerConfigOptions): Promise<string> {
  const builtConfigPath = path.join(cwd, "dist", "server", "wrangler.json");
  if (!(await fileExists(builtConfigPath))) {
    if (verbose) {
      console.log(
        chalk.dim(
          "No Vite-built wrangler config found; using generated wrangler config.",
        ),
      );
    }
    return generatedWranglerConfigPath;
  }

  await patchBuiltWranglerConfigPrivate(
    builtConfigPath,
    generatedWranglerConfigPath,
  );

  if (verbose) {
    console.log(
      chalk.dim(
        `Using Vite-built deploy config: ${path.relative(cwd, builtConfigPath)}`,
      ),
    );
  }

  return builtConfigPath;
}

/**
 * The Vite-built config carries the app's own bindings (R2, AI, send_email,
 * …) but none of the private-worker identity: it keeps the wrangler.jsonc
 * name and lacks the gateway identity vars. Graft those from the generated
 * config so the deploy targets the registered `every-<appId>` worker.
 */
async function patchBuiltWranglerConfigPrivate(
  configPath: string,
  generatedWranglerConfigPath: string,
): Promise<void> {
  const config = await readJsonc(configPath);
  const generated = await readJsonc(generatedWranglerConfigPath);

  delete config["configPath"];
  delete config["userConfigPath"];
  delete config["routes"];
  delete config["route"];

  // Fail closed: a generated config without the private-worker name or the
  // gateway identity vars means the deploy would ship a wrongly-named or
  // identity-less worker (e.g. a build step reran generate-config and
  // clobbered the deploy-enriched version).
  const generatedName = generated["name"];
  if (typeof generatedName !== "string" || generatedName.length === 0) {
    throw new Error(
      `Generated config ${generatedWranglerConfigPath} has no worker name; aborting deploy.`,
    );
  }
  const generatedVars = generated["vars"] as
    Record<string, unknown> | undefined;
  for (const requiredVar of [
    "EVERYAPP_IDENTITY_PUBLIC_KEYS",
    "EVERYAPP_IDENTITY_ISSUER",
  ]) {
    const value = generatedVars?.[requiredVar];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `Generated config ${generatedWranglerConfigPath} is missing ${requiredVar}; aborting deploy.`,
      );
    }
  }

  config["name"] = generatedName;
  if ("topLevelName" in config) {
    config["topLevelName"] = generatedName;
  }
  config["workers_dev"] = false;
  config["preview_urls"] = false;
  config["vars"] = {
    ...(config["vars"] as Record<string, unknown> | undefined),
    ...generatedVars,
  };

  // The gateway service binding (EVERY_APP_GATEWAY -> AppGateway) is emitted
  // only into the generated config; a Vite build never sees it. Graft it in,
  // replacing any same-named built binding and preserving unrelated ones.
  const generatedServices = generated["services"];
  if (Array.isArray(generatedServices) && generatedServices.length > 0) {
    const graftedNames = new Set(
      generatedServices.map((s) => (s as { binding?: string }).binding),
    );
    const builtServices = Array.isArray(config["services"])
      ? (config["services"] as Array<{ binding?: string }>)
      : [];
    config["services"] = [
      ...builtServices.filter((s) => !graftedNames.has(s.binding)),
      ...generatedServices,
    ];
  }

  await fs.writeFile(
    configPath,
    JSON.stringify(config, null, 2) + "\n",
    "utf-8",
  );
}

async function readJsonc(filePath: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(filePath, "utf-8");
  const errors: ParseError[] = [];
  const parsed = parseJsonc(raw, errors, { allowTrailingComma: true }) as
    Record<string, unknown> | undefined;
  if (errors.length > 0 || parsed === undefined) {
    throw new Error(`Failed to parse ${filePath} as JSONC.`);
  }
  return parsed;
}

async function removeStaleBuiltWranglerConfig(cwd: string): Promise<void> {
  await fs.rm(path.join(cwd, "dist", "server", "wrangler.json"), {
    force: true,
  });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function hasViteConfig(cwd: string): Promise<boolean> {
  const candidates = [
    "vite.config.ts",
    "vite.config.mts",
    "vite.config.js",
    "vite.config.mjs",
    "vite.config.cjs",
    "vite.config.cts",
  ];
  const results = await Promise.all(
    candidates.map((candidate) => fileExists(path.join(cwd, candidate))),
  );
  return results.some(Boolean);
}
