/**
 * The workspace `everyapp workspace` acts on: the install's organization
 * (registry.ts `installOrganization`), written in the Gateway's D1 under
 * the Cloudflare login, the way `provider on` writes its rows. The Gateway
 * reads the `organizations` row live (nothing caches its name), so a
 * session sees a change on its next page.
 */
import type { D1Database } from "@/lib/cf/d1";
import { EveryAppError } from "@/lib/errors";
import { installOrganization, registryCall, type Organization } from "./registry";

/**
 * The workspace a command acts on: the install's organization, once it has
 * an owner. Before the setup claim there is nothing to act on: the claim
 * names the organization after its owner (or `platformOrganizationName`),
 * so anything written before it would be overwritten.
 */
async function claimedWorkspace(db: D1Database): Promise<Organization> {
  const found = await installOrganization(db);
  if (!found || !found.hasOwner) {
    throw new EveryAppError(
      "WORKSPACE_NOT_CLAIMED",
      "The Gateway has no owner yet\nThe setup claim makes the workspace, named after its owner; rename it after.",
      { fix: "open the Gateway in a browser and claim it, then run this again" },
    );
  }
  return found.organization;
}

/**
 * Rename the install's organization to `name` (already valid by the shared
 * rule). Its slug stays, as the Gateway's own rename keeps it. Whether the
 * name changed, and what it was.
 */
export function renameInstallOrganization(
  db: D1Database,
  name: string,
): Promise<{ organization: Organization; previousName: string; changed: boolean }> {
  return registryCall(async () => {
    const organization = await claimedWorkspace(db);
    const changed = organization.name !== name;
    if (changed) {
      await db.run([
        { sql: "UPDATE organizations SET name = ? WHERE id = ?", params: [name, organization.id] },
      ]);
    }
    return {
      organization: { ...organization, name },
      previousName: organization.name,
      changed,
    };
  });
}
