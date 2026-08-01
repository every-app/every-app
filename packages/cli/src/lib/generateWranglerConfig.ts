import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { z } from "zod";
import {
  ManifestError,
  validateManifestStrict,
  workerNameFor,
  type EveryAppManifest,
} from "@every-app/perimeter/manifest";

const GENERATED_CONFIG_DIR = ".everyapp";
const GENERATED_WRANGLER_CONFIG = "wrangler.json";
const DEFAULT_WORKER_MAIN = "src/entry.worker.ts";
export const COMPATIBILITY_DATE = "2026-06-01";
const EVERYAPP_COMPATIBILITY_FLAGS = ["nodejs_compat"] as const;

const GENERATED_NOTE = "generated from everyapp.config.ts — do not edit";

// The shared strict manifest schema covers every CLI field (including the
// dev command string and devPort), so the CLI adds nothing on top.
export type EveryAppCliManifest = EveryAppManifest;

interface GenerateWranglerConfigOptions {
  /** JSON array of SPKI PEM public keys injected for SDK identity verification. */
  identityPublicKeys?: string[];
  /** Extra vars to inject (for example, identity issuer). */
  vars?: Record<string, string>;
  /** Provisioned Cloudflare resource IDs keyed by manifest binding name. */
  d1DatabaseIds?: Record<string, string>;
  kvNamespaceIds?: Record<string, string>;
  /** Production-only private app-to-gateway binding identity. */
  gatewayBinding?: { organizationId: string };
}

interface WranglerConfig {
  $schema: string;
  name: string;
  main: string;
  compatibility_date: string;
  compatibility_flags: string[];
  workers_dev: false;
  preview_urls: false;
  observability: { enabled: true };
  dev?: { port: number };
  vars?: Record<string, string>;
  d1_databases?: Array<{
    binding: string;
    database_name: string;
    database_id?: string;
    migrations_dir: string;
  }>;
  kv_namespaces?: Array<{ binding: string; id?: string }>;
  durable_objects?: { bindings: Array<{ name: string; class_name: string }> };
  migrations?: Array<{ tag: string; new_sqlite_classes: string[] }>;
  services?: Array<{
    binding: string;
    service: string;
    entrypoint: string;
    props: {
      organizationId: string;
      appId: string;
      workerName: string;
    };
  }>;
}

interface EnsureGeneratedWranglerConfigResult {
  manifest: EveryAppCliManifest;
  config: WranglerConfig;
  configPath: string;
}

export async function loadEveryAppManifest(
  cwd: string,
): Promise<EveryAppCliManifest> {
  const manifestPath = path.join(cwd, "everyapp.config.ts");
  try {
    await fs.access(manifestPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new ManifestError(
        "No everyapp.config.ts found in the current directory — run this command from an app root.",
      );
    }
    throw error;
  }

  const jiti = createJiti(pathToFileURL(manifestPath).href);
  const raw = await jiti.import(manifestPath, { default: true });
  return validateCliManifestStrict(raw);
}

function validateCliManifestStrict(input: unknown): EveryAppCliManifest {
  return validateManifestStrict(input);
}

export function resourceNameFor(appId: string, binding?: string): string {
  const workerName = workerNameFor(appId);
  if (!binding || binding === "DB" || binding === "KV") {
    return workerName;
  }
  return `${workerName}-${binding.toLowerCase()}`;
}

export function generateWranglerConfig(
  manifest: EveryAppCliManifest,
  options: GenerateWranglerConfigOptions = {},
): WranglerConfig {
  const manifestMain = toPosixPath(manifest.main ?? DEFAULT_WORKER_MAIN);
  const main = isBareModuleSpecifier(manifestMain)
    ? manifestMain
    : path.posix.join("..", manifestMain);

  const config: WranglerConfig = {
    $schema: "../node_modules/wrangler/config-schema.json",
    name: workerNameFor(manifest.id),
    main,
    compatibility_date: manifest.compatibilityDate ?? COMPATIBILITY_DATE,
    compatibility_flags: [...EVERYAPP_COMPATIBILITY_FLAGS],
    workers_dev: false,
    preview_urls: false,
    observability: { enabled: true },
  };

  if (manifest.devPort) {
    config.dev = { port: manifest.devPort };
  }

  const vars: Record<string, string> = {
    ...options.vars,
    EVERYAPP_APP_ID: manifest.id,
  };
  if (options.identityPublicKeys) {
    vars["EVERYAPP_IDENTITY_PUBLIC_KEYS"] = JSON.stringify(
      options.identityPublicKeys,
    );
  }
  config.vars = vars;

  if (options.gatewayBinding) {
    const organizationId = options.gatewayBinding.organizationId.trim();
    if (!organizationId) {
      throw new Error(
        "Cannot generate EVERY_APP_GATEWAY binding without an organization id.",
      );
    }
    config.services = [
      {
        binding: "EVERY_APP_GATEWAY",
        service: "every-app-gateway",
        entrypoint: "AppGateway",
        props: {
          organizationId,
          appId: manifest.id,
          workerName: workerNameFor(manifest.id),
        },
      },
    ];
  }

  const d1 = manifest.resources?.d1 ?? [];
  if (d1.length > 0) {
    const migrationsDir = toPosixPath(manifest.migrations?.dir ?? "drizzle");
    config.d1_databases = d1.map((binding) => ({
      binding,
      database_name: resourceNameFor(manifest.id, binding),
      database_id:
        options.d1DatabaseIds?.[binding] ??
        resourceNameFor(manifest.id, binding),
      migrations_dir: path.posix.join("..", migrationsDir),
    }));
  }

  const kv = manifest.resources?.kv ?? [];
  if (kv.length > 0) {
    config.kv_namespaces = kv.map((binding) => ({
      binding,
      ...(options.kvNamespaceIds?.[binding]
        ? { id: options.kvNamespaceIds[binding] }
        : {}),
    }));
  }

  const durableObjects = manifest.resources?.durableObjects ?? [];
  if (durableObjects.length > 0) {
    config.durable_objects = {
      bindings: durableObjects.map((durableObject) => ({
        name: durableObject.name,
        class_name: durableObject.className,
      })),
    };
    config.migrations = [
      {
        tag: "v1",
        new_sqlite_classes: durableObjects.map(
          (durableObject) => durableObject.className,
        ),
      },
    ];
  }

  return config;
}

/**
 * Wrangler accepts either a source file or a package import as `main`.
 * Package imports must stay verbatim so Node can resolve their exports, while
 * source files move up one directory because this config lives in .everyapp/.
 *
 * A leading dot or slash is unambiguously a file path. We also preserve the
 * existing workspace conventions for `src/...` entries and Worker source-file
 * extensions; every other bare value is treated as a package specifier.
 */
function isBareModuleSpecifier(main: string): boolean {
  return (
    !main.startsWith(".") &&
    !main.startsWith("/") &&
    !main.startsWith("src/") &&
    !/\.[cm]?[jt]sx?$/.test(main)
  );
}

export async function ensureGeneratedWranglerConfig(
  cwd: string,
  options: GenerateWranglerConfigOptions & {
    manifest?: EveryAppCliManifest;
  } = {},
): Promise<EnsureGeneratedWranglerConfigResult> {
  const manifest = options.manifest ?? (await loadEveryAppManifest(cwd));
  const config = generateWranglerConfig(manifest, options);
  const configPath = path.join(
    cwd,
    GENERATED_CONFIG_DIR,
    GENERATED_WRANGLER_CONFIG,
  );

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, serializeWranglerConfig(config), "utf-8");
  await ensureGeneratedDirectoryGitignored(cwd);

  return { manifest, config, configPath };
}

function serializeWranglerConfig(config: WranglerConfig): string {
  return `// ${GENERATED_NOTE}\n${JSON.stringify(config, null, 2)}\n`;
}

async function ensureGeneratedDirectoryGitignored(cwd: string): Promise<void> {
  const gitignorePath = path.join(cwd, ".gitignore");
  let content = "";
  try {
    content = await fs.readFile(gitignorePath, "utf-8");
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }

  const lines = content.split(/\r?\n/).map((line) => line.trim());
  if (
    lines.includes(GENERATED_CONFIG_DIR) ||
    lines.includes(`${GENERATED_CONFIG_DIR}/`)
  ) {
    return;
  }

  const separator =
    content.length > 0 ? (content.endsWith("\n") ? "" : "\n") : "";
  await fs.writeFile(
    gitignorePath,
    `${content}${separator}# every app generated config\n${GENERATED_CONFIG_DIR}/\n`,
    "utf-8",
  );
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}
