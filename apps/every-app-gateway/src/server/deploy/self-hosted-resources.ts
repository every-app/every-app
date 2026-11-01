/** REST adapter for the exact resource provisioner the self-hosted CLI uses. */
import {
  aiGatewaySettings,
  aiGatewayUpdate,
  createResourceProvisioner,
  InstallationError,
  type AiGateway,
  type HyperdriveConfig,
  type ResourceOperations,
  type SecretsStore,
  type SecretsStoreSecret,
  type VectorizeIndex,
} from "@every-app/perimeter/install";
import { CloudflareTransport, json } from "./cf-rest/client";
import { CloudflareApiError } from "./cf-rest/errors";

export async function accountRequest<T>(
  cf: CloudflareTransport,
  segments: string[],
  method = "GET",
  body?: unknown,
): Promise<T> {
  return cf.request<T>(
    cf.accountPath(...segments),
    body === undefined ? { method } : json(method, body),
    { context: `${method} ${segments.join("/")}`, envelopeOptional: true },
  );
}

export async function accountList<T>(
  cf: CloudflareTransport,
  segments: string[],
  query: Record<string, string> = {},
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; page <= 50; page++) {
    const params = new URLSearchParams({
      ...query,
      per_page: "100",
      page: String(page),
    });
    const { result, resultInfo } = await cf.requestWithInfo<T[]>(
      `${cf.accountPath(...segments)}?${params}`,
      {},
      { context: `List ${segments.join("/")}` },
    );
    if (!Array.isArray(result))
      throw new Error("Cloudflare returned an invalid resource list.");
    rows.push(...result);
    if (
      resultInfo?.total_pages !== undefined
        ? page >= resultInfo.total_pages
        : result.length < (resultInfo?.per_page ?? 100)
    )
      return rows;
  }
  throw new InstallationError(
    "RESOURCE_LIST_TOO_LARGE",
    "This account's resources could not be fully listed. Nothing with an unverified owner will be reused.",
  );
}

async function optional<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch (error) {
    if (
      error instanceof CloudflareApiError &&
      [404, 410].includes(error.status)
    )
      return null;
    throw error;
  }
}

const operations: ResourceOperations<CloudflareTransport> = {
  Error: InstallationError,
  CLI: "everyapp",
  thisCommand: () => "",
  isCfError: (error, kind) =>
    error instanceof CloudflareApiError &&
    (kind === "already_exists"
      ? error.status === 409 ||
        error.errors.some((detail) =>
          [7502, 10014, 11009].includes(Number(detail.code)),
        )
      : kind === "r2_not_enabled"
        ? error.errors.some((detail) => Number(detail.code) === 10042)
        : error.status >= 500),
  findD1: async (cf, name) =>
    (
      await accountList<{ name: string; uuid: string }>(
        cf,
        ["d1", "database"],
        { name },
      )
    ).find((db) => db.name === name)?.uuid ?? null,
  createD1: async (cf, name) =>
    (
      await accountRequest<{ uuid: string }>(cf, ["d1", "database"], "POST", {
        name,
      })
    ).uuid,
  findKv: async (cf, name) =>
    (
      await accountList<{ title: string; id: string }>(cf, [
        "storage",
        "kv",
        "namespaces",
      ])
    ).find((kv) => kv.title === name)?.id ?? null,
  createKv: async (cf, title) =>
    (
      await accountRequest<{ id: string }>(
        cf,
        ["storage", "kv", "namespaces"],
        "POST",
        { title },
      )
    ).id,
  findR2Bucket: async (cf, name) =>
    !!(await optional(() => accountRequest(cf, ["r2", "buckets", name]))),
  createR2Bucket: async (cf, name) => {
    await accountRequest(cf, ["r2", "buckets"], "POST", { name });
  },
  getWorkerDeployment: (cf, name) =>
    optional(() =>
      accountRequest(cf, ["workers", "scripts", name, "deployments"]),
    ),
  findHyperdrive: async (cf, name) =>
    (await accountList<HyperdriveConfig>(cf, ["hyperdrive", "configs"])).find(
      (config) => config.name === name,
    ) ?? null,
  createHyperdrive: async (cf, name, origin, caching) =>
    (
      await accountRequest<{ id: string }>(
        cf,
        ["hyperdrive", "configs"],
        "POST",
        { name, origin, caching: { disabled: caching === "off" } },
      )
    ).id,
  updateHyperdrive: async (cf, id, change) => {
    await accountRequest(cf, ["hyperdrive", "configs", id], "PATCH", {
      ...(change.origin ? { origin: change.origin } : {}),
      ...(change.caching
        ? { caching: { disabled: change.caching === "off" } }
        : {}),
    });
  },
  listQueues: (cf) => accountRequest(cf, ["queues"]),
  getQueue: (cf, id) => optional(() => accountRequest(cf, ["queues", id])),
  createQueue: async (cf, queue_name) =>
    (
      await accountRequest<{ queue_id: string }>(cf, ["queues"], "POST", {
        queue_name,
      })
    ).queue_id,
  getVectorizeIndex: (cf, name) =>
    optional(() => accountRequest(cf, ["vectorize", "v2", "indexes", name])),
  createVectorizeIndex: (cf, name, config) =>
    accountRequest<VectorizeIndex>(cf, ["vectorize", "v2", "indexes"], "POST", {
      name,
      config,
    }),
  findAiGateway: (cf, id) =>
    optional(() =>
      accountRequest<AiGateway>(cf, ["ai-gateway", "gateways", id]),
    ),
  createAiGateway: (cf, id, settings) =>
    accountRequest(cf, ["ai-gateway", "gateways"], "POST", {
      id,
      collect_logs: aiGatewaySettings(settings).collectLogs,
      cache_ttl: aiGatewaySettings(settings).cacheTtl,
      authentication: false,
      cache_invalidate_on_update: false,
      rate_limiting_interval: 0,
      rate_limiting_limit: 0,
    }),
  updateAiGateway: (cf, existing, settings) =>
    accountRequest(
      cf,
      ["ai-gateway", "gateways", existing.id],
      "PUT",
      aiGatewayUpdate(existing, settings),
    ),
  listSecretsStores: (cf) =>
    accountList<SecretsStore>(cf, ["secrets_store", "stores"]),
  findStoreSecret: async (cf, store, name) =>
    (
      await accountList<SecretsStoreSecret>(
        cf,
        ["secrets_store", "stores", store, "secrets"],
        { search: name },
      )
    ).find((secret) => secret.name === name && secret.status !== "deleted") ??
    null,
  createStoreSecret: async (cf, store, name, value) =>
    (
      await accountRequest<Array<{ id: string }>>(
        cf,
        ["secrets_store", "stores", store, "secrets"],
        "POST",
        [{ name, value, scopes: ["workers"] }],
      )
    )[0]!.id,
};

export const { claimAppWorker, provisionAppResources, ensureAppBuckets } =
  createResourceProvisioner(operations);
