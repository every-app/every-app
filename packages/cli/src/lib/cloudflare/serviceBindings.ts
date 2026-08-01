import {
  CloudflareAPIError,
  getDefaultAccountId,
  makeCloudflareAPIRequest,
} from "@/lib/cloudflare/auth";
import { listD1Databases } from "@/lib/cloudflare/d1";

const GATEWAY_WORKER_NAME = "every-app-gateway";
const GATEWAY_D1_DATABASE_NAME = "every-app-gateway";
const APP_SERVICE_BINDING_PREFIX = "APP__";

interface CloudflareBinding {
  name: string;
  type: string;
  service?: string;
  [key: string]: unknown;
}

interface D1QueryResponse {
  results?: Array<Record<string, unknown>>;
  result?: Array<Record<string, unknown>>;
}

export interface GatewayServiceBinding {
  binding: string;
  service: string;
}

export async function computeGatewayServiceBindings(
  accountId?: string,
): Promise<GatewayServiceBinding[]> {
  const resolvedAccountId = accountId ?? (await getDefaultAccountId());
  const databases = await listD1Databases(resolvedAccountId);
  const gatewayDatabase = databases.find(
    (database) => database.name === GATEWAY_D1_DATABASE_NAME,
  );

  if (!gatewayDatabase) {
    return [];
  }

  let rows: Array<Record<string, unknown>>;
  try {
    rows = await queryGatewayD1WorkerNames(
      resolvedAccountId,
      gatewayDatabase.uuid,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      error instanceof CloudflareAPIError &&
      (message.includes("no such table") ||
        message.includes("no such column") ||
        message.includes("D1_ERROR"))
    ) {
      return [];
    }
    throw error;
  }

  const workerNames = rows
    .map((row) => row["worker_name"])
    .filter(
      (value): value is string =>
        typeof value === "string" && value.length > 0,
    );

  return [...new Set(workerNames)]
    .sort()
    .map((workerName) => ({
      binding: `${APP_SERVICE_BINDING_PREFIX}${workerName}`,
      service: workerName,
    }));
}

export async function replaceGatewayServiceBindings(
  accountId?: string,
): Promise<GatewayServiceBinding[]> {
  const resolvedAccountId = accountId ?? (await getDefaultAccountId());
  const currentBindings = await getGatewayScriptBindings(resolvedAccountId);
  const preservedBindings = currentBindings.flatMap((binding) => {
    assertReservedAppBindingIsService(binding);

    if (
      binding.type === "service" &&
      binding.name.startsWith(APP_SERVICE_BINDING_PREFIX)
    ) {
      return [];
    }

    // Inherit rather than reconstruct: the GET response may omit fields the
    // binding still carries server-side (WorkerEntrypoint props, cross-account
    // grants, secret contents), so re-serializing would silently drop them.
    return [{ type: "inherit", name: binding.name }];
  });
  const serviceBindings = await computeGatewayServiceBindings(resolvedAccountId);
  const bindings = [
    ...preservedBindings,
    ...serviceBindings.map((binding) => ({
      type: "service",
      name: binding.binding,
      service: binding.service,
    })),
  ];

  await patchGatewayScriptSettings(resolvedAccountId, bindings);
  return serviceBindings;
}

// Script settings (GET and PATCH) live at /settings — the sibling
// /script-settings endpoint only covers logpush/observability/tail_consumers
// and silently ignores bindings.
async function getGatewayScriptBindings(
  accountId: string,
): Promise<CloudflareBinding[]> {
  const settings = await makeCloudflareAPIRequest<{
    bindings?: CloudflareBinding[];
  }>(`/accounts/${accountId}/workers/scripts/${GATEWAY_WORKER_NAME}/settings`);
  return settings.bindings ?? [];
}

async function patchGatewayScriptSettings(
  accountId: string,
  bindings: Array<Record<string, unknown>>,
): Promise<void> {
  // This endpoint requires multipart/form-data with the JSON in a `settings`
  // part (same shape wrangler uses); a raw JSON body gets 415 [10001].
  const form = new FormData();
  form.set("settings", JSON.stringify({ bindings }));
  await makeCloudflareAPIRequest(
    `/accounts/${accountId}/workers/scripts/${GATEWAY_WORKER_NAME}/settings`,
    {
      method: "PATCH",
      body: form,
    },
  );
}

function assertReservedAppBindingIsService(
  binding: CloudflareBinding,
): void {
  if (
    binding.name.startsWith(APP_SERVICE_BINDING_PREFIX) &&
    binding.type !== "service"
  ) {
    throw new Error(
      `Gateway binding "${binding.name}" uses the reserved ${APP_SERVICE_BINDING_PREFIX} namespace but is not a service binding.`,
    );
  }
}

async function queryGatewayD1WorkerNames(
  accountId: string,
  databaseId: string,
): Promise<Array<Record<string, unknown>>> {
  const response = await makeCloudflareAPIRequest<
    D1QueryResponse | D1QueryResponse[]
  >(`/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: "POST",
    body: JSON.stringify({
      sql:
        "SELECT worker_name FROM apps WHERE status = 'active' AND worker_name IS NOT NULL AND hostname IS NOT NULL",
    }),
  });

  const first = Array.isArray(response) ? response[0] : response;
  return first?.results ?? first?.result ?? [];
}
