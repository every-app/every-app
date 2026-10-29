/** Reconcile Access with the same route plan and PUT body as CLI installs. */
import { db } from "@/db";
import { appBaseDomain } from "@/server/app-hosts";
import {
  applicationUpdateBody,
  appsDestinations,
  findAccessApplications,
  managedOAuthOn,
  sameDestinations,
  splitDestinations,
  storedBearerRoutes,
  storedMcp,
  storedPublicRoutes,
  type AccessApplication,
} from "@every-app/perimeter/install";
import { env } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { withInstallLease } from "./browser-install";
import { CloudflareTransport } from "./cf-rest/client";
import { DeployError } from "./errors";
import { accountList, accountRequest } from "./self-hosted-resources";

export async function syncBrowserAccess(
  cf: CloudflareTransport,
  appId: string,
): Promise<void> {
  // Without Access configured there are no edge exceptions to change, and
  // the deploy token does not need permission to read a Zero Trust account.
  if (!env.CLOUDFLARE_ACCESS_TEAM_DOMAIN) return;
  const base = appBaseDomain(env);
  if (!base)
    throw new DeployError(
      "DEPLOYER_NOT_CONFIGURED",
      503,
      "The Gateway has no app base domain.",
    );
  const scope = {
    gatewayHost: new URL(env.GATEWAY_URL).hostname,
    appBaseDomain: base,
  };
  await withInstallLease("access", "access.sync", async (renew) => {
    const found = findAccessApplications(
      await accountList<AccessApplication>(cf, ["access", "apps"]),
      scope,
    );
    if (!found.apps)
      throw new DeployError(
        "ACCESS_NOT_CONFIGURED",
        503,
        "Cloudflare Access is configured but its apps application was not found. Run everyapp access on to reconcile it.",
      );
    const rows = await db.all<{
      app_slug: string;
      hostname: string;
      manifest: string;
    }>(
      sql`SELECT app_slug, hostname, manifest FROM apps WHERE status IN ('binding', 'active', 'disabled') AND hostname IS NOT NULL`,
    );
    const plan = appsDestinations(
      scope.appBaseDomain,
      rows.map((row) => ({
        appId: String(row.app_slug),
        hostname: String(row.hostname),
        publicPaths: storedPublicRoutes(row.manifest).map(
          (route) => route.path,
        ),
        bearerPaths: storedBearerRoutes(row.manifest),
        mcp: storedMcp(row.manifest) !== null,
      })),
      { managedOAuth: managedOAuthOn(found.gateway) },
    );
    if (
      plan.dropped.some((route) => route.appId === appId) ||
      plan.outsideBase.includes(appId)
    )
      throw new DeployError(
        "ACCESS_ROUTES_UNSUPPORTED",
        422,
        "Cloudflare Access cannot expose every declared public or bearer route. Adjust the app's route patterns before installing.",
      );
    const current = found.apps.destinations ?? [];
    const { foreign } = splitDestinations(current, scope);
    const gatewayKept =
      found.gateway?.id === found.apps.id
        ? current.filter(
            (destination) =>
              (destination.uri ?? "").toLowerCase().replace(/\/+$/, "") ===
              scope.gatewayHost,
          )
        : [];
    const destinations = [...foreign, ...gatewayKept, ...plan.destinations];
    if (sameDestinations(current, destinations)) return;
    await renew();
    await accountRequest(
      cf,
      ["access", "apps", found.apps.id],
      "PUT",
      applicationUpdateBody(found.apps, {
        destinations: destinations as never,
      }),
    );
  });
}
