import { sql } from "drizzle-orm";
import { db } from "@/db";
import { platformPolicy } from "@/server/platform-policy";
import { DeployError } from "./errors";

interface BrowserInstallEnv {
  GATEWAY_DEPLOYMENT_MODE?: string;
  BROWSER_APP_INSTALLS?: string;
  CF_DEPLOY_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  APP_BASE_DOMAIN?: string;
}

// Deliberately the existing deployer's subset: D1, own DOs, static assets.
export const BROWSER_INSTALL_LIMITS = {
  cpuMs: 5_000,
  subrequests: 200,
  durableObjectClasses: 2,
};

export function selfHostedInstallEnabled(env: BrowserInstallEnv): boolean {
  return (
    platformPolicy(env).mode === "self_hosted" &&
    env.BROWSER_APP_INSTALLS !== "off" &&
    Boolean(
      env.CF_DEPLOY_TOKEN?.trim() &&
        /^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID ?? "") &&
        env.APP_BASE_DOMAIN,
    )
  );
}

/** Keep CLI reconciliation aware of the Gateway settings this install published. */
export async function recordBrowserGatewayDeployment(
  versionId: string,
  workerName: string,
  hostname: string,
  actor: string | null,
): Promise<void> {
  const updated = await db.all(sql`UPDATE _everyapp_install SET
    live_version_id = ${versionId},
    live_app_workers = CASE WHEN EXISTS (SELECT 1 FROM json_each(live_app_workers) WHERE value = ${workerName})
      THEN live_app_workers ELSE json_insert(live_app_workers, '$[#]', ${workerName}) END,
    live_domains = CASE WHEN EXISTS (SELECT 1 FROM json_each(live_domains) WHERE value = ${hostname})
      THEN live_domains ELSE json_insert(live_domains, '$[#]', ${hostname}) END,
    updated_at = ${Date.now()}, updated_by = ${actor}
    WHERE id = 'install' RETURNING id`);
  if (!updated.length)
    throw new DeployError(
      "DEPLOYER_NOT_CONFIGURED",
      503,
      "The Gateway's CLI install record is missing. Finish Gateway setup before installing apps.",
    );
}

/** Shares the CLI's lease table/ids, so browser and terminal installs serialize. */
export async function withInstallLease<T>(
  id: string,
  purpose: string,
  work: (renew: () => Promise<void>) => Promise<T>,
): Promise<T> {
  await db.run(
    sql`CREATE TABLE IF NOT EXISTS _everyapp_deploy_lease (id TEXT PRIMARY KEY, holder TEXT NOT NULL, purpose TEXT NOT NULL, acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
  );
  const holder = crypto.randomUUID();
  const now = Date.now();
  const ttl = 180_000;
  const acquired =
    await db.all(sql`INSERT INTO _everyapp_deploy_lease (id, holder, purpose, acquired_at, expires_at)
    VALUES (${id}, ${holder}, ${purpose}, ${now}, ${now + ttl})
    ON CONFLICT(id) DO UPDATE SET holder = excluded.holder, purpose = excluded.purpose, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
    WHERE _everyapp_deploy_lease.expires_at < ${now} RETURNING holder`);
  if (!acquired.length)
    throw new DeployError(
      "DEPLOY_IN_PROGRESS",
      409,
      "Another install or CLI operation is running. Try again when it finishes.",
    );
  const renew = async () => {
    const time = Date.now();
    const held = await db.all(
      sql`UPDATE _everyapp_deploy_lease SET expires_at = ${time + ttl} WHERE id = ${id} AND holder = ${holder} AND expires_at > ${time} RETURNING holder`,
    );
    if (!held.length)
      throw new DeployError(
        "LEASE_LOST",
        409,
        "The install lost its deployment lease. Try again.",
      );
  };
  try {
    return await work(renew);
  } finally {
    await db.run(
      sql`DELETE FROM _everyapp_deploy_lease WHERE id = ${id} AND holder = ${holder}`,
    );
  }
}
