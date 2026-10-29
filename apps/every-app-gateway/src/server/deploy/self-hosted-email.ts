/** Account API adapter for the CLI's shared inbound-email reconciliation. */
import {
  createEmailInstaller,
  EmailRoutingRuleListOutput,
  EmailRoutingRuleOutput,
  EmailRoutingSettingsOutput,
  InstallationError,
  type EmailOperations,
} from "@every-app/perimeter/install";
import { CloudflareTransport, json } from "./cf-rest/client";
import { isCloudflareNotFound } from "./cf-rest/errors";

async function zoneRequest<T>(
  cf: CloudflareTransport,
  zone: string,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  return cf.request<T>(
    `/zones/${encodeURIComponent(zone)}/${path}`,
    body === undefined ? { method } : json(method, body),
    { context: `${method} Email Routing`, envelopeOptional: true },
  );
}
const operations: EmailOperations<CloudflareTransport> = {
  Error: InstallationError,
  CLI: "everyapp",
  isCfError: (error) => isCloudflareNotFound(error),
  confirmAtTerminal: async () => false,
  confirmOrCancel: async () => {
    throw new InstallationError(
      "CONFIRMATION_REQUIRED",
      "Confirm the Email Routing change before installing.",
    );
  },
  appIdOfWorker: async (db, worker) => {
    const [rows] = await db.run([
      {
        sql: "SELECT app_slug FROM apps WHERE worker_name = ?",
        params: [worker],
      },
    ]);
    return rows?.[0] ? String(rows[0].app_slug) : null;
  },
  resolveZone: async (cf, host, account) => {
    const labels = host.toLowerCase().split(".");
    for (let offset = 0; offset < labels.length - 1; offset++) {
      const name = labels.slice(offset).join(".");
      const zones = await cf.request<
        Array<{ id: string; name: string; status?: string }>
      >(
        `/zones?${new URLSearchParams({ name, "account.id": account, per_page: "50" })}`,
        {},
        { context: "Find the email domain's zone" },
      );
      const zone = zones.find((zone) => zone.name.toLowerCase() === name);
      if (zone) {
        if (zone.status && zone.status !== "active")
          throw new InstallationError(
            "ZONE_NOT_ACTIVE",
            `The zone ${name} is not active.`,
          );
        return { id: zone.id, name: zone.name };
      }
    }
    throw new InstallationError(
      "ZONE_NOT_FOUND",
      `${host} has no zone in this Cloudflare account.`,
    );
  },
  dnsRecordsAt: (cf, zone, name) =>
    zoneRequest(
      cf,
      zone,
      `dns_records?${new URLSearchParams({ name, per_page: "100" })}`,
    ),
  getEmailRoutingSettings: async (cf, zone) =>
    EmailRoutingSettingsOutput.parse(
      await zoneRequest(cf, zone, "email/routing"),
    ),
  enableEmailRouting: async (cf, zone, name) => {
    await zoneRequest(cf, zone, "email/routing/enable", "POST", { name });
  },
  listEmailRoutingRules: async (cf, zone) => {
    const rules: ReturnType<typeof EmailRoutingRuleListOutput.parse> = [];
    for (let page = 1; page <= 10; page++) {
      const result = await zoneRequest<unknown[]>(
        cf,
        zone,
        `email/routing/rules?page=${page}&per_page=50`,
      );
      rules.push(...EmailRoutingRuleListOutput.parse(result));
      if (result.length < 50) return rules;
    }
    throw new InstallationError(
      "EMAIL_ROUTES_TOO_MANY",
      "The domain's Email Routing rules could not be fully listed.",
    );
  },
  getEmailRoutingRule: async (cf, zone, id) => {
    try {
      return EmailRoutingRuleOutput.parse(
        await zoneRequest(
          cf,
          zone,
          `email/routing/rules/${encodeURIComponent(id)}`,
        ),
      );
    } catch (error) {
      if (isCloudflareNotFound(error)) return null;
      throw error;
    }
  },
  getEmailRoutingCatchAll: async (cf, zone) =>
    EmailRoutingRuleOutput.parse(
      await zoneRequest(cf, zone, "email/routing/rules/catch_all"),
    ),
  createEmailRoutingRule: async (cf, zone, body) => {
    const result = EmailRoutingRuleOutput.parse(
      await zoneRequest(cf, zone, "email/routing/rules", "POST", body),
    );
    if (!result.id)
      throw new InstallationError(
        "EMAIL_ROUTE_MISSING",
        "Cloudflare did not return the new rule's ID.",
      );
    return result.id;
  },
  updateEmailRoutingRule: async (cf, zone, id, body) => {
    await zoneRequest(
      cf,
      zone,
      `email/routing/rules/${encodeURIComponent(id)}`,
      "PUT",
      body,
    );
  },
  deleteEmailRoutingRule: async (cf, zone, id) => {
    try {
      await zoneRequest(
        cf,
        zone,
        `email/routing/rules/${encodeURIComponent(id)}`,
        "DELETE",
      );
      return true;
    } catch (error) {
      if (isCloudflareNotFound(error)) return false;
      throw error;
    }
  },
  updateEmailRoutingCatchAll: async (cf, zone, body) => {
    await zoneRequest(cf, zone, "email/routing/rules/catch_all", "PUT", body);
  },
};
export const { planEmailRoutes, applyEmailRoutes, emailDeclarations } =
  createEmailInstaller(operations);
