/** Convert the CLI-validated Build Output to Cloudflare's upload wire format. */
import type {
  BuiltWorkerConfig,
  InstallTarget,
} from "@every-app/perimeter/install";
import { bundleModuleType, type Manifest } from "@every-app/perimeter/manifest";
import type { DeployBundle } from "./bundle";
import type { WorkerBinding, WorkerMetadata, WorkerModule } from "./cf-rest";
import { DeployError } from "./errors";

function apiKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(apiKeys);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
        apiKeys(entry),
      ]),
    );
  return value;
}

export function selfHostedMetadata(
  config: BuiltWorkerConfig,
  target: InstallTarget,
  manifest: Manifest,
  values: Readonly<Record<string, string>>,
  assetsJwt?: string,
): WorkerMetadata {
  const bindings: WorkerBinding[] = [];
  for (const [name, binding] of Object.entries(config.env ?? {})) {
    switch (binding.type) {
      case "text":
        bindings.push({
          type: "plain_text",
          name,
          text: String(binding.value),
        });
        break;
      case "json":
        bindings.push({
          type: "json",
          name,
          json: JSON.stringify(
            name === "EVERYAPP_MANIFEST" ? manifest : binding.value,
          ),
        });
        break;
      case "secret":
        if (values[name] !== undefined)
          bindings.push({ type: "secret_text", name, text: values[name]! });
        break;
      case "d1":
        bindings.push({ type: "d1", name, id: String(binding.id) });
        break;
      case "kv":
        bindings.push({
          type: "kv_namespace",
          name,
          namespace_id: String(binding.id),
        });
        break;
      case "r2":
        bindings.push({
          type: "r2_bucket",
          name,
          bucket_name: String(binding.name),
          ...(binding.jurisdiction
            ? { jurisdiction: String(binding.jurisdiction) }
            : {}),
        });
        break;
      case "worker":
        bindings.push({
          type: "service",
          name,
          service: String(binding.worker),
          ...(binding.exportName
            ? { entrypoint: String(binding.exportName) }
            : {}),
          ...(binding.props && typeof binding.props === "object"
            ? { props: binding.props as Record<string, unknown> }
            : {}),
        });
        break;
      case "durable-object":
        bindings.push({
          type: "durable_object_namespace",
          name,
          class_name: String(binding.exportName),
          ...(binding.worker !== config.name
            ? { script_name: String(binding.worker) }
            : {}),
        });
        break;
      case "workflow":
        bindings.push({
          type: "workflow",
          name,
          workflow_name: String(binding.name),
          class_name: String(binding.exportName),
          script_name: String(binding.worker),
        });
        break;
      case "hyperdrive":
        bindings.push({ type: "hyperdrive", name, id: String(binding.id) });
        break;
      case "queue":
        bindings.push({
          type: "queue",
          name,
          queue_name: String(binding.name),
        });
        break;
      case "vectorize":
        bindings.push({
          type: "vectorize",
          name,
          index_name: String(binding.name),
        });
        break;
      case "analytics-engine-dataset":
        bindings.push({
          type: "analytics_engine",
          name,
          dataset: String(binding.name),
        });
        break;
      case "secrets-store-secret":
        bindings.push({
          type: "secrets_store_secret",
          name,
          store_id: String(binding.storeId),
          secret_name: String(binding.secretName),
        });
        break;
      case "send-email":
        bindings.push({
          type: "send_email",
          name,
          ...(binding.allowedSenderAddresses
            ? {
                allowed_sender_addresses:
                  binding.allowedSenderAddresses as string[],
              }
            : {}),
          ...(binding.destinationAddress
            ? { destination_address: String(binding.destinationAddress) }
            : {}),
          ...(binding.allowedDestinationAddresses
            ? {
                allowed_destination_addresses:
                  binding.allowedDestinationAddresses as string[],
              }
            : {}),
        });
        break;
      case "ai":
      case "browser":
      case "images":
      case "assets":
        bindings.push({ type: binding.type, name });
        break;
      case "version-metadata":
        bindings.push({ type: "version_metadata", name });
        break;
      default:
        throw new DeployError(
          "INVALID_BINDING",
          422,
          `Unsupported binding ${name}: ${String(binding.type)}.`,
        );
    }
  }
  // Production builds leave app settings and secrets to the installer.
  // As in CLI secret writes, supplied values replace build-time bindings.
  for (const [name, text] of Object.entries(values)) {
    const binding: WorkerBinding = { type: "secret_text", name, text };
    const index = bindings.findIndex((current) => current.name === name);
    if (index < 0) bindings.push(binding);
    else bindings[index] = binding;
  }
  // The caller identity of the app's Gateway entrypoint is assigned by the
  // installer, irrespective of any props supplied by the release.
  const gateway = bindings.find(
    (binding) => binding.name === "EVERY_APP_GATEWAY",
  );
  if (gateway?.type === "service")
    gateway.props = {
      organizationId: target.organizationId,
      appId: manifest.id,
      workerName: target.workerName,
    };
  const assets = config.assets as Record<string, unknown> | undefined;
  const placement = config.placement as WorkerMetadata["placement"] | undefined;
  const limits = config.limits as
    | { cpuMs?: number; subrequests?: number }
    | undefined;
  return {
    main_module: String(config.manifest?.mainModule),
    compatibility_date: String(config.compatibilityDate),
    compatibility_flags: (config.compatibilityFlags ?? []) as string[],
    bindings,
    keep_bindings: ["secret_text"],
    ...(assetsJwt
      ? {
          assets: {
            jwt: assetsJwt,
            config: {
              html_handling: assets?.htmlHandling as "auto-trailing-slash",
              not_found_handling: assets?.notFoundHandling as "none",
              run_worker_first: assets?.runWorkerFirst as boolean,
            },
          },
        }
      : {}),
    ...(config.observability
      ? {
          observability: apiKeys(
            config.observability,
          ) as WorkerMetadata["observability"],
        }
      : {}),
    ...(placement
      ? { placement: { ...placement, mode: placement.mode ?? "targeted" } }
      : {}),
    ...(limits
      ? { limits: { cpu_ms: limits.cpuMs, subrequests: limits.subrequests } }
      : {}),
    ...(config.cache
      ? {
          cache_options: apiKeys(
            config.cache,
          ) as WorkerMetadata["cache_options"],
        }
      : {}),
    ...(typeof config.logpush === "boolean" ? { logpush: config.logpush } : {}),
    ...(Array.isArray(config.tags) ? { tags: config.tags as string[] } : {}),
  };
}

export function selfHostedModules(
  bundle: DeployBundle,
  config: BuiltWorkerConfig,
): WorkerModule[] {
  const modules: WorkerModule[] = [];
  for (const [name, content] of bundle.modules) {
    const type = bundleModuleType(name, config.manifest?.modules?.[name]?.type);
    if (type) modules.push({ name, type, content });
  }
  if (
    !modules.some(
      (module) =>
        module.name === config.manifest?.mainModule && module.type === "esm",
    )
  )
    throw new DeployError(
      "INVALID_BUNDLE",
      422,
      "The release has no main ES module.",
    );
  return modules;
}
