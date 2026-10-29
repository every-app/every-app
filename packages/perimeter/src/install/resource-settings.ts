/** Resource comparisons and update bodies shared by both Cloudflare adapters. */
import type {
  AiGateway,
  AiGatewaySettings,
  HyperdriveCaching,
  HyperdriveConfig,
  SecretsStore,
  VectorizeIndex,
  VectorizeShape,
} from "./resource-port";
import type { HyperdriveOrigin } from "./secrets";

export function cachesAs(
  config: HyperdriveConfig,
  caching: HyperdriveCaching,
): boolean {
  return (config.caching?.disabled === true) === (caching === "off");
}

export function connectsTo(
  config: HyperdriveConfig,
  origin: HyperdriveOrigin,
): boolean {
  const current = config.origin;
  return (
    current?.host === origin.host &&
    (current.port ?? null) === origin.port &&
    current.database === origin.database &&
    current.user === origin.user
  );
}

export function chooseSecretsStore(
  stores: readonly SecretsStore[],
): SecretsStore | null {
  return stores.find((store) => store.name === "everyapp") ?? stores[0] ?? null;
}

export function hasVectorizeShape(
  index: VectorizeIndex,
  shape: VectorizeShape,
): boolean {
  const config = index.config ?? {};
  return "preset" in shape
    ? config.preset === shape.preset
    : config.dimensions === shape.dimensions && config.metric === shape.metric;
}

export function describeVectorizeShape(
  shape: VectorizeShape | NonNullable<VectorizeIndex["config"]>,
): string {
  if ("preset" in shape && shape.preset) return `the preset ${shape.preset}`;
  const dimensions = "dimensions" in shape ? shape.dimensions : undefined;
  const metric = "metric" in shape ? shape.metric : undefined;
  return `${dimensions ?? "?"} dimensions, ${metric ?? "no metric"}`;
}

export function aiGatewaySettings(
  settings: AiGatewaySettings,
): Required<AiGatewaySettings> {
  return {
    collectLogs: settings.collectLogs ?? true,
    cacheTtl: settings.cacheTtl ?? 0,
  };
}

export function hasAiGatewaySettings(
  gateway: AiGateway,
  settings: AiGatewaySettings,
): boolean {
  const wanted = aiGatewaySettings(settings);
  return (
    (gateway.collect_logs ?? false) === wanted.collectLogs &&
    (gateway.cache_ttl ?? 0) === wanted.cacheTtl
  );
}

/** A PUT preserves known mutable settings without sending read-only API fields. */
export function aiGatewayUpdate(
  gateway: AiGateway,
  settings: AiGatewaySettings,
): Record<string, unknown> {
  const kept = Object.fromEntries(
    [
      "authentication",
      "byok_only",
      "cache_invalidate_on_update",
      "log_classification",
      "log_management",
      "log_management_strategy",
      "logpush",
      "logpush_public_key",
      "rate_limiting_interval",
      "rate_limiting_limit",
      "rate_limiting_technique",
      "retry_backoff",
      "retry_delay",
      "retry_max_attempts",
      "store_id",
      "workers_ai_billing_mode",
      "zdr",
    ].flatMap((field) =>
      gateway[field] === undefined || gateway[field] === null
        ? []
        : [[field, gateway[field]]],
    ),
  );
  const wanted = aiGatewaySettings(settings);
  return {
    cache_invalidate_on_update: false,
    rate_limiting_interval: 0,
    rate_limiting_limit: 0,
    ...kept,
    collect_logs: wanted.collectLogs,
    cache_ttl: wanted.cacheTtl,
  };
}
