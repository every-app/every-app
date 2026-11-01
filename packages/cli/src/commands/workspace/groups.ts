/**
 * `everyapp workspace groups` and `workspace group create|set|delete|
 * members|apps`: named sets of members that apps are granted to as one
 * (lib/gateway/workspace.ts does the reading and writing).
 */
import chalk from "chalk";
import { EveryAppError } from "@/lib/errors";
import * as workspace from "@/lib/gateway/workspace";
import { CLI } from "@/lib/output/command";
import { confirmUnlessYes } from "@/lib/output/prompt";
import { runCommand } from "@/lib/output/run";
import { formatTable } from "@/lib/output/table";
import { plural } from "@/lib/output/text";
import {
  connect,
  interactiveIn,
  listChange,
  memberData,
  memberState,
  when,
  type WorkspaceFlags,
  type WorkspaceOptions,
} from "./shared";

const STEP = "workspace.update";

type ChangeFlags = WorkspaceFlags & { add?: string[]; remove?: string[]; set?: string[] };

export async function groups(flags: WorkspaceFlags): Promise<void> {
  await runCommand(flags, (out) => listGroups({ flags, out }));
}

export async function groupCreate(flags: WorkspaceFlags & { description?: string }, name: string): Promise<void> {
  await runCommand(flags, (out) => createGroup({ flags, out }, name));
}

export async function groupSet(
  flags: WorkspaceFlags & { name?: string; description?: string },
  group: string,
): Promise<void> {
  await runCommand(flags, (out) => updateGroup({ flags, out }, group));
}

export async function groupDelete(flags: WorkspaceFlags & { yes?: boolean }, group: string): Promise<void> {
  await runCommand(flags, (out) => deleteGroup({ flags, out }, group));
}

export async function groupMembers(flags: ChangeFlags, group: string): Promise<void> {
  await runCommand(flags, (out) => groupMembersCommand({ flags, out }, group));
}

export async function groupApps(flags: ChangeFlags, group: string): Promise<void> {
  await runCommand(flags, (out) => groupAppsCommand({ flags, out }, group));
}

const groupData = (group: workspace.WorkspaceGroup) => ({
  id: group.id,
  name: group.name,
  description: group.description,
  members: group.memberCount,
  apps: group.appCount,
  createdAt: new Date(group.createdAt).toISOString(),
});

export async function listGroups(options: WorkspaceOptions): Promise<void> {
  const { out } = options;
  const { ws } = await connect(options);
  const rows = await workspace.listGroups(ws);
  const table = formatTable(
    ["GROUP", "MEMBERS", "APPS", "DESCRIPTION", "ID"],
    rows.map((group) => [
      group.name,
      String(group.memberCount),
      String(group.appCount),
      group.description ?? chalk.dim("–"),
      chalk.dim(group.id),
    ]),
  );
  out.emit({
    type: "done",
    message: `${plural(rows.length, "group")} in ${ws.organization.name}`,
    display:
      rows.length > 0
        ? table.join("\n")
        : chalk.dim(`No groups in ${ws.organization.name} yet: ${CLI} workspace group create <name>`),
    data: { organization: ws.organization, groups: rows.map(groupData) },
  });
}

export async function createGroup(
  options: WorkspaceOptions<WorkspaceFlags & { description?: string }>,
  name: string,
): Promise<void> {
  const { out, flags } = options;
  const { ws } = await connect(options);
  out.emit({ type: "step", step: STEP, status: "start", message: `Creating the group ${name}...` });
  const group = await workspace.createGroup(ws, { name, description: flags.description });
  out.emit({ type: "step", step: STEP, status: "ok", message: `Created ${group.name}`, data: { groupId: group.id } });
  out.emit({
    type: "done",
    message: `Created the group ${group.name} (${group.id}) in ${ws.organization.name}.`,
    data: {
      organization: ws.organization,
      group: groupData(group),
      next: [
        { command: `${CLI} workspace group members ${quoted(group.name)} --add <email>`, note: "who is in it" },
        { command: `${CLI} workspace group apps ${quoted(group.name)} --add <app>`, note: "which apps it opens" },
      ],
    },
  });
}

/** A group name as a shell takes it back, for the commands suggested next. */
const quoted = (name: string) => (/^[\w.-]+$/.test(name) ? name : `'${name.replace(/'/g, `'\\''`)}'`);

export async function updateGroup(
  options: WorkspaceOptions<WorkspaceFlags & { name?: string; description?: string }>,
  identifier: string,
): Promise<void> {
  const { out, flags } = options;
  if (flags.name === undefined && flags.description === undefined) {
    throw new EveryAppError("NOTHING_TO_SET", "Nothing to set: give --name or --description");
  }
  const { ws } = await connect(options);
  out.emit({ type: "step", step: STEP, status: "start", message: `Updating ${identifier}...` });
  const group = await workspace.updateGroup(ws, identifier, { name: flags.name, description: flags.description });
  out.emit({ type: "step", step: STEP, status: "ok", message: `Updated ${group.name}`, data: { groupId: group.id } });
  out.emit({
    type: "done",
    message: `${group.name} (${group.id}): ${group.description ? `"${group.description}"` : "no description"}.`,
    data: { organization: ws.organization, group: groupData(group) },
  });
}

export async function deleteGroup(
  options: WorkspaceOptions<WorkspaceFlags & { yes?: boolean }>,
  identifier: string,
): Promise<void> {
  const { out, flags } = options;
  const { ws } = await connect(options);
  const group = await workspace.findGroup(ws, identifier);
  await confirmUnlessYes({
    yes: flags.yes,
    interactive: interactiveIn(options),
    confirm: options.confirm,
    question: `Delete the group ${group.name}?`,
    unattended: "Deleting a group needs confirmation at a terminal, or --yes",
    context: [
      `It has ${plural(group.memberCount, "member")} and opens ${plural(group.appCount, "app")}; what it granted ends with it.`,
    ],
    cancelled: "Cancelled. Nothing deleted.",
    data: { groupId: group.id, name: group.name },
  });
  out.emit({ type: "step", step: STEP, status: "start", message: `Deleting ${group.name}...` });
  await workspace.deleteGroup(ws, group.id);
  out.emit({ type: "step", step: STEP, status: "ok", message: `Deleted ${group.name}`, data: { groupId: group.id } });
  const lines = [
    `Deleted the group ${group.name} from ${ws.organization.name}.`,
    `Its ${plural(group.memberCount, "member")} keep their direct grants and other groups; the ${plural(group.appCount, "app")} it opened are no longer open through it.`,
  ];
  out.emit({
    type: "done",
    message: lines.join("\n"),
    display: [lines[0], chalk.dim(lines[1]!)].join("\n"),
    data: { organization: ws.organization, group: groupData(group) },
  });
}

export async function groupMembersCommand(
  options: WorkspaceOptions<ChangeFlags>,
  identifier: string,
): Promise<void> {
  const { out, flags } = options;
  const { change } = listChange(flags);
  const { ws } = await connect(options);
  const group = await workspace.findGroup(ws, identifier);
  let added: workspace.WorkspaceMember[] = [];
  let removed: workspace.WorkspaceMember[] = [];
  let members: workspace.GroupMemberState[];
  if (change) {
    out.emit({ type: "step", step: STEP, status: "start", message: `Changing who is in ${group.name}...` });
    const result = await workspace.setGroupMembers(ws, group, change);
    ({ added, removed, members } = result);
    out.emit({
      type: "step",
      step: STEP,
      status: "ok",
      message: `${group.name}: ${plural(added.length, "member")} added, ${removed.length} removed`,
      data: { groupId: group.id, added: added.length, removed: removed.length },
    });
  } else {
    members = await workspace.groupMembers(ws, group);
  }
  const inGroup = members.filter((member) => member.inGroup);
  const table = formatTable(
    ["EMAIL", "ROLE", "STATUS", "IN GROUP"],
    members.map((member) => [
      member.email,
      member.primaryRole ?? member.role,
      memberState(member),
      member.inGroup ? chalk.green("yes") : chalk.dim("no"),
    ]),
  );
  const headline = change
    ? `${group.name}: added ${added.length > 0 ? added.map((member) => member.email).join(", ") : "nobody"}, removed ${removed.length > 0 ? removed.map((member) => member.email).join(", ") : "nobody"}; ${plural(inGroup.length, "member")} in it now.`
    : `${plural(inGroup.length, "member")} in ${group.name}, of ${members.length} in ${ws.organization.name}.`;
  out.emit({
    type: "done",
    message: headline,
    display: [headline, table.join("\n")].join("\n"),
    data: {
      organization: ws.organization,
      group: groupData({ ...group, memberCount: inGroup.length }),
      members: members.map((member) => ({ ...memberData(member), inGroup: member.inGroup })),
      ...(change ? { added: added.map(memberData), removed: removed.map(memberData) } : {}),
    },
  });
}

export async function groupAppsCommand(
  options: WorkspaceOptions<ChangeFlags>,
  identifier: string,
): Promise<void> {
  const { out, flags } = options;
  const { change } = listChange(flags);
  const { ws } = await connect(options);
  const group = await workspace.findGroup(ws, identifier);
  let added: workspace.WorkspaceApp[] = [];
  let removed: workspace.WorkspaceApp[] = [];
  let apps: workspace.GroupAppState[];
  if (change) {
    out.emit({ type: "step", step: STEP, status: "start", message: `Changing which apps ${group.name} opens...` });
    const result = await workspace.setGroupApps(ws, group, change);
    ({ added, removed, apps } = result);
    out.emit({
      type: "step",
      step: STEP,
      status: "ok",
      message: `${group.name}: ${plural(added.length, "app")} granted, ${removed.length} revoked`,
      data: { groupId: group.id, granted: added.length, revoked: removed.length },
    });
  } else {
    apps = await workspace.groupApps(ws, group);
  }
  const granted = apps.filter((app) => app.granted);
  const table = formatTable(
    ["APP", "NAME", "STATUS", "OPENS"],
    apps.map((app) => [app.appSlug, app.name, app.status, app.granted ? chalk.green("yes") : chalk.dim("no")]),
  );
  const headline = change
    ? `${group.name}: granted ${added.length > 0 ? added.map((app) => app.appSlug).join(", ") : "nothing"}, revoked ${removed.length > 0 ? removed.map((app) => app.appSlug).join(", ") : "nothing"}; it opens ${plural(granted.length, "app")} now.`
    : `${group.name} opens ${plural(granted.length, "app")} of ${ws.organization.name}'s ${apps.length}.`;
  out.emit({
    type: "done",
    message: headline,
    display: [headline, table.join("\n"), chalk.dim(`Updated ${when(ws.now)} UTC`)].join("\n"),
    data: {
      organization: ws.organization,
      group: groupData({ ...group, appCount: granted.length }),
      apps: apps.map((app) => ({ id: app.id, appId: app.appSlug, name: app.name, status: app.status, granted: app.granted })),
      ...(change
        ? {
            added: added.map((app) => ({ id: app.id, appId: app.appSlug })),
            removed: removed.map((app) => ({ id: app.id, appId: app.appSlug })),
          }
        : {}),
    },
  });
}
