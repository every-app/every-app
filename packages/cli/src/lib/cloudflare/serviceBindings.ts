import chalk from "chalk";
import {
  GATEWAY_WORKER_NAME,
  isAppWorkerName,
} from "@every-app/perimeter/manifest";
import {
  CloudflareAPIError,
  getDefaultAccountId,
  makeCloudflareAPIRequest,
} from "@/lib/cloudflare/auth";
import {
  findGatewayDatabaseId,
  queryGatewayD1,
} from "@/lib/cloudflare/gatewayD1";

const APP_SERVICE_BINDING_PREFIX = "APP__";

interface CloudflareBinding {
  name: string;
  type: string;
  service?: string;
  [key: string]: unknown;
}

export interface GatewayServiceBinding {
  binding: string;
  service: string;
}

/**
 * The app service bindings the gateway should have: one per active
 * registered app. A row is bound only if its worker name is the one
 * `everyapp deploy` gives that app id (never another Worker in the account,
 * never the gateway itself); anything else is skipped with a warning
 * instead of failing the whole reconcile.
 */
export async function computeGatewayServiceBindings(
  accountId?: string,
): Promise<GatewayServiceBinding[]> {
  const resolvedAccountId = accountId ?? (await getDefaultAccountId());
  const databaseId = await findGatewayDatabaseId(resolvedAccountId);

  if (!databaseId) {
    return [];
  }

  let rows: Array<Record<string, unknown>>;
  try {
    rows = await queryGatewayD1(
      resolvedAccountId,
      databaseId,
      "SELECT app_slug, worker_name FROM apps WHERE status = 'active' AND worker_name IS NOT NULL AND hostname IS NOT NULL",
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

  const workerNames: string[] = [];
  for (const row of rows) {
    const appSlug = row["app_slug"];
    const workerName = row["worker_name"];
    if (typeof workerName !== "string" || workerName.length === 0) continue;
    if (typeof appSlug !== "string" || !isAppWorkerName(appSlug, workerName)) {
      console.warn(
        chalk.yellow(
          `Skipping the service binding for "${workerName}": it is not the Worker name for app "${String(appSlug)}".`,
        ),
      );
      continue;
    }
    workerNames.push(workerName);
  }

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
