/**
 * `everyapp workspace linked-dev on|off|show`: the organization's switch
 * for linked dev (docs/design/linked-dev.md §4.1, `org_settings.linked_dev`,
 * migration 0022). Off, no owner or admin can sign `everyapp dev --gateway`
 * in to the organization's apps and the Gateway's `/linked-dev/<app>` route
 * answers nothing for them; on, they can, and every call bills the
 * organization's providers. Written as the operator (ADR-0003), as the
 * caps and the default model are, with an `organization.linked_dev_changed`
 * event in the write's own batch.
 */
import type { D1Statement } from "@/lib/cf/d1";
import { EMPTY_ORG_SETTINGS_SQL } from "./costCaps";
import { operatorActor, queueEventFromCli } from "./events";
import type { Workspace } from "./workspace";

/** Whether linked dev is on for the workspace's organization. */
export async function readLinkedDev(ws: Workspace): Promise<boolean> {
  const [rows = []] = await ws.db.run([
    {
      sql: "SELECT linked_dev FROM org_settings WHERE organization_id = ?",
      params: [ws.organization.id],
    },
  ]);
  return Number(rows[0]?.["linked_dev"] ?? 0) === 1;
}

interface LinkedDevChange {
  on: boolean;
  was: boolean;
}

/**
 * Turn linked dev on or off. The row is written in place; turning it off
 * drops the row when nothing else is left in it (caps, the default model).
 * `organization.linked_dev_changed` goes in the same batch when the value
 * changed; nothing is written or announced when it didn't.
 */
export async function setLinkedDev(ws: Workspace, on: boolean): Promise<LinkedDevChange> {
  const was = await readLinkedDev(ws);
  if (was === on) return { on, was };
  const org = ws.organization.id;
  const event = await queueEventFromCli(ws.db, {
    organizationId: org,
    actor: operatorActor(ws.operator),
    now: ws.now,
    type: "organization.linked_dev_changed",
    data: { linkedDev: on ? "on" : "off" },
  });
  const write: D1Statement[] = [
    {
      sql: `INSERT INTO org_settings (organization_id, linked_dev, updated_at, updated_by)
VALUES (?1, ?2, ?3, ?4)
ON CONFLICT (organization_id) DO UPDATE SET linked_dev = ?2, updated_at = ?3, updated_by = ?4`,
      params: [org, on ? 1 : 0, ws.now, ws.operator.userId],
    },
    ...(on
      ? []
      : [
          { sql: `DELETE FROM org_settings WHERE organization_id = ? AND ${EMPTY_ORG_SETTINGS_SQL}`, params: [org] },
        ]),
  ];
  await ws.db.run([...write, ...event]);
  return { on, was };
}
