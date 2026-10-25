/**
 * `everyapp workspace show|users|invite|invite-link|uninvite|deactivate|
 * reactivate|remove|reset-link`: the organization and its people, managed
 * from the terminal under the Cloudflare login (lib/gateway/workspace.ts
 * does the reading and writing; this file says what happened). The
 * groups, apps and the read-only trails are in the files beside this one.
 */
import { stripVTControlCharacters } from "node:util";
import { GATEWAY_WORKER_NAME } from "@every-app/perimeter/manifest";
import { MAX_ORGANIZATION_NAME_LENGTH, validOrganizationName } from "@every-app/sdk/internal";
import chalk from "chalk";
import { listWorkerSecrets } from "@/lib/cf/secrets";
import { EveryAppError } from "@/lib/errors";
import { connectToGateway, requestedGatewayUrl } from "@/lib/gateway/connect";
import { setMemberRole } from "@/lib/gateway/members";
import { installOrganization } from "@/lib/gateway/registry";
import * as workspace from "@/lib/gateway/workspace";
import { CLI } from "@/lib/output/command";
import { ticked } from "@/lib/output/events";
import { canPromptInTerminal, confirmUnlessYes } from "@/lib/output/prompt";
import { runCommand } from "@/lib/output/run";
import { formatFacts, formatTable } from "@/lib/output/table";
import { listed, plural } from "@/lib/output/text";
import type { GatewayCommandFlags } from "../flags";
import type { WorkspaceRole } from "./command";
import {
  connect,
  interactiveIn,
  invitationData,
  iso,
  memberData,
  memberState,
  when,
  type WorkspaceFlags,
  type WorkspaceOptions,
} from "./shared";

const STEP = "workspace.update";
const RENAME_STEP = "workspace.rename";
const ROLE_STEP = "workspace.role";

export async function rename(flags: GatewayCommandFlags, name: string): Promise<void> {
  await runCommand(flags, (out) => renameWorkspace({ flags, out }, name));
}

export async function role(flags: GatewayCommandFlags, email: string, role: WorkspaceRole): Promise<void> {
  await runCommand(flags, (out) => setRole({ flags, out }, email, role));
}

/** The Gateway through the login, for the commands that act on the install organization. */
function connectGateway(options: WorkspaceOptions) {
  const { flags, out } = options;
  return connectToGateway({
    gateway: requestedGatewayUrl(flags.gateway),
    accountId: flags["account-id"],
    interactive: canPromptInTerminal(flags.json ?? false),
    login: { json: flags.json, out, step: "login" },
    createCf: options.createCf,
  });
}

/** "an owner", "an admin", "a member". */
const withArticle = (role: string) => `${/^[aeiou]/.test(role) ? "an" : "a"} ${role}`;

/**
 * `workspace role <email> <owner|admin|member>`: a member's role in the
 * install's workspace, set in the Gateway's D1 (lib/gateway/members.ts),
 * for when the Gateway's own Users page isn't the way: the only owner is
 * locked out, or a script sets up a team. The rule is the Gateway's
 * (MembershipService): owners are peers, and the workspace always keeps at
 * least one who can act, so an owner's role is never changed while no
 * other owner is live. The Gateway reads a role change within 30 seconds.
 */
export async function setRole(options: WorkspaceOptions, email: string, role: WorkspaceRole): Promise<void> {
  const { out } = options;
  const address = email.trim().toLowerCase();
  const gateway = await connectGateway(options);
  const found = await installOrganization(gateway.db);
  if (!found) {
    throw new EveryAppError(
      "MEMBER_NOT_FOUND",
      "This Gateway has no workspace yet\nNobody has claimed its owner link, so it has no members.",
      { rerun: `${CLI} setup`, rerunNote: "to claim it" },
    );
  }
  const { organization } = found;
  const workspaceData = { id: organization.id, name: organization.name };
  out.emit({ type: "step", step: ROLE_STEP, status: "start", message: `Setting ${address}'s role...` });
  const result = await setMemberRole(gateway.db, organization.id, address, role);
  if (result.kind === "not_found") {
    throw new EveryAppError(
      "MEMBER_NOT_FOUND",
      `No member ${address} in ${organization.name}\nSomeone still invited isn't a member until they accept.`,
      {
        fix: "check the address against Manage workspace → Users, or invite them first",
        data: { workspace: workspaceData, email: address },
      },
    );
  }
  const member = { id: result.member.id, email: result.member.email, name: result.member.name };
  if (result.kind === "last_owner") {
    throw new EveryAppError(
      "LAST_OWNER",
      `${address} is the last owner of ${organization.name}\nThe workspace always keeps one owner, so their role stays until someone else is an owner.`,
      {
        rerun: `${CLI} workspace role <email> owner`,
        rerunNote: "for someone else, then this command again",
        data: { workspace: workspaceData, member, role },
      },
    );
  }
  const changed = result.kind === "changed";
  const line = changed
    ? `${address} is now ${withArticle(role)} of ${organization.name}`
    : `${address} is already ${withArticle(role)} of ${organization.name}`;
  out.emit({ type: "step", step: ROLE_STEP, status: "ok", message: line, data: { email: address, role, changed } });
  const note = changed ? "The Gateway picks up the change within 30 seconds." : "Nothing changed.";
  out.emit({
    type: "done",
    message: stripVTControlCharacters(`${line}. ${note}`),
    display: [changed ? ticked(line) : chalk.dim(`${line}.`), chalk.dim(note)].join("\n"),
    data: {
      workspace: workspaceData,
      member,
      role,
      changed,
      ...(changed ? { previousRole: result.previousRole } : {}),
    },
  });
}

/**
 * `workspace rename <name>`: the workspace's name, written on the install's
 * organization row (lib/gateway/workspace.ts `renameInstallOrganization`).
 * The name follows the rule the Gateway's own rename applies
 * (`validOrganizationName` in `@every-app/sdk/internal`), checked before
 * anything is read, so a refused name costs no login. The Gateway reads
 * the row live and each member sees the name on their next page.
 */
export async function renameWorkspace(options: WorkspaceOptions, rawName: string): Promise<void> {
  const { out } = options;
  // The name first: no login, no network.
  const name = validOrganizationName(rawName);
  if (!name) {
    throw new EveryAppError(
      "WORKSPACE_NAME_INVALID",
      `Use 1 to ${MAX_ORGANIZATION_NAME_LENGTH} characters with no line breaks\nA name is trimmed, and runs of spaces become one.`,
      { fix: "give the name as one argument, quoted when it has spaces" },
    );
  }
  const gateway = await connectGateway(options);
  out.emit({ type: "step", step: RENAME_STEP, status: "start", message: "Renaming the workspace..." });
  const { organization, previousName, changed } = await workspace.renameInstallOrganization(gateway.db, name);
  out.emit({
    type: "step",
    step: RENAME_STEP,
    status: "ok",
    message: changed ? `Renamed ${previousName} to ${name}` : `${name} already`,
    data: { id: organization.id, name, previousName, changed },
  });
  const headline = changed ? `Renamed the workspace to ${name}.` : `The workspace is named ${name} already.`;
  const note = changed ? "Members see the name on their next page." : "Nothing changed.";
  out.emit({
    type: "done",
    message: stripVTControlCharacters(`${headline} ${note}`),
    display: [headline, chalk.dim(note)].join("\n"),
    data: {
      organization: { id: organization.id, name: organization.name, slug: organization.slug },
      previousName,
      changed,
      gateway: gateway.gatewayUrl,
    },
  });
}

export async function show(flags: WorkspaceFlags): Promise<void> {
  await runCommand(flags, (out) => showWorkspace({ flags, out }));
}

export async function users(flags: WorkspaceFlags): Promise<void> {
  await runCommand(flags, (out) => listUsers({ flags, out }));
}

export async function invite(flags: WorkspaceFlags & { role: "member" | "admin" }, email: string): Promise<void> {
  await runCommand(flags, (out) => inviteMember({ flags, out }, email, flags.role));
}

export async function inviteLink(flags: WorkspaceFlags, invitation: string): Promise<void> {
  await runCommand(flags, (out) => newInviteLink({ flags, out }, invitation));
}

export async function uninvite(flags: WorkspaceFlags, invitation: string): Promise<void> {
  await runCommand(flags, (out) => cancelInvitation({ flags, out }, invitation));
}

export async function deactivate(flags: WorkspaceFlags, user: string): Promise<void> {
  await runCommand(flags, (out) => deactivateMember({ flags, out }, user));
}

export async function reactivate(flags: WorkspaceFlags, user: string): Promise<void> {
  await runCommand(flags, (out) => reactivateMember({ flags, out }, user));
}

export async function remove(flags: WorkspaceFlags & { yes?: boolean }, user: string): Promise<void> {
  await runCommand(flags, (out) => removeMember({ flags, out }, user));
}

export async function resetLink(flags: WorkspaceFlags, user: string): Promise<void> {
  await runCommand(flags, (out) => passwordResetLink({ flags, out }, user));
}

/** The Gateway settings that let someone past Access join without an invitation (names only). */
const ACCESS_AUTO_JOIN_SETTINGS = ["CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS", "CLOUDFLARE_ACCESS_OUTER_RING_AUTO_JOIN"];

/**
 * Whether the Gateway can mail, as far as its setting names say: a sender
 * and a provider key (server/email/sendEmail.ts reads the values).
 */
function emailConfigured(names: readonly string[]): boolean {
  return names.includes("EMAIL_FROM") && (names.includes("RESEND_API_KEY") || names.includes("EMAIL_REST_API_TOKEN"));
}

export async function showWorkspace(options: WorkspaceOptions): Promise<void> {
  const { out } = options;
  const { gateway, ws, gatewayUrl } = await connect(options);
  const [summary, names] = await Promise.all([
    workspace.summarize(ws),
    listWorkerSecrets(gateway.cf, GATEWAY_WORKER_NAME),
  ]);
  const { organization, owners, counts } = summary;
  const operator = ws.operator;
  const email = emailConfigured(names);
  const you =
    operator.email === null
      ? `${operator.actor} (an API token; no account)`
      : operator.userId
        ? `${operator.email}`
        : `${operator.email} (no account on this Gateway)`;
  const facts = [
    { label: "Organization", value: `${organization.name} ${chalk.dim(`(${organization.slug}, ${organization.id})`)}` },
    { label: "Gateway", value: chalk.cyan(gatewayUrl) },
    { label: "Owners", value: owners.length > 0 ? owners.join(", ") : chalk.yellow("none yet (claim the Gateway: everyapp setup)") },
    { label: "You", value: you },
    { label: "Email", value: email ? "configured: the Gateway can mail invitations from Admin → Users" : chalk.dim("not configured: this CLI prints links to hand over") },
    { label: "Members", value: `${counts.members}${counts.deactivated > 0 ? chalk.dim(` (${counts.deactivated} deactivated)`) : ""}` },
    { label: "Invitations", value: `${counts.invitations} pending` },
    { label: "Groups", value: String(counts.groups) },
    { label: "Apps", value: String(counts.apps) },
  ];
  const message = `${organization.name}: ${plural(counts.members, "member")}, ${plural(counts.invitations, "pending invitation")}, ${plural(counts.groups, "group")}, ${plural(counts.apps, "app")}`;
  out.emit({
    type: "done",
    message,
    display: formatFacts(facts).join("\n"),
    data: {
      organization,
      gateway: gatewayUrl,
      owners,
      operator: { actor: operator.actor, email: operator.email, userId: operator.userId },
      email: { configured: email },
      counts,
    },
  });
}

export async function listUsers(options: WorkspaceOptions): Promise<void> {
  const { out } = options;
  const { ws } = await connect(options);
  const { members, invitations } = await workspace.listUsers(ws);
  const rows = [
    ...members.map((member) => [
      member.email,
      member.name && member.name !== member.email ? member.name : chalk.dim("–"),
      member.primaryRole ?? member.role,
      memberState(member),
      when(member.createdAt),
    ]),
    ...invitations.map((invitation) => [
      invitation.email,
      chalk.dim("–"),
      invitation.role,
      invitation.live ? chalk.cyan(`invited, expires ${when(invitation.expiresAt)}`) : chalk.dim("invitation expired"),
      when(invitation.createdAt),
    ]),
  ];
  const table = formatTable(["EMAIL", "NAME", "ROLE", "STATUS", "SINCE"], rows);
  // "Pending" counts what can still be accepted, as `workspace show` counts it; expired rows are listed, and said.
  const expired = invitations.filter((invitation) => !invitation.live).length;
  const summary = `${plural(members.length, "member")} and ${plural(invitations.length - expired, "pending invitation")}${expired > 0 ? ` (${expired} expired)` : ""} in ${ws.organization.name}`;
  out.emit({
    type: "done",
    message: summary,
    display: rows.length > 0 ? table.join("\n") : chalk.dim(`Nobody in ${ws.organization.name} yet.`),
    data: {
      organization: ws.organization,
      members: members.map(memberData),
      invitations: invitations.map(invitationData),
    },
  });
}

export async function inviteMember(
  options: WorkspaceOptions,
  email: string,
  role: "member" | "admin",
): Promise<void> {
  const { out } = options;
  const { ws, gatewayUrl } = await connect(options);
  out.emit({ type: "step", step: STEP, status: "start", message: `Inviting ${email}...` });
  const { invitation, token } = await workspace.invite(ws, email, role);
  const url = workspace.invitationUrl(gatewayUrl, token);
  out.emit({
    type: "step",
    step: STEP,
    status: "ok",
    message: `Invited ${invitation.email} as ${role}`,
    data: { invitationId: invitation.id },
  });
  const lines = [
    `Invited ${invitation.email} to ${ws.organization.name} as ${role}.`,
    `Send them this link (it is the invitation's only secret; it expires ${when(invitation.expiresAt)} UTC):`,
    `  ${url}`,
    `The Gateway mailed nothing; Admin → Users mails invitations when email is configured.`,
  ];
  out.emit({
    type: "done",
    message: stripVTControlCharacters(lines.join("\n")),
    display: [lines[0], chalk.dim(lines[1]!), chalk.cyan(lines[2]!), chalk.dim(lines[3]!)].join("\n"),
    data: {
      organization: ws.organization,
      invitation: invitationData(invitation),
      url,
      emailed: false,
      next: [{ command: `${CLI} workspace invite-link ${invitation.email}`, note: "a new link, if this one is lost" }],
    },
  });
}

export async function newInviteLink(options: WorkspaceOptions, identifier: string): Promise<void> {
  const { out } = options;
  const { ws, gatewayUrl } = await connect(options);
  const { invitation, token } = await workspace.inviteLink(ws, identifier);
  const url = workspace.invitationUrl(gatewayUrl, token);
  const lines = [
    `A new link for ${invitation.email}'s invitation to ${ws.organization.name} (expires ${when(invitation.expiresAt)} UTC):`,
    `  ${url}`,
    "Earlier links keep working until the invitation is accepted or canceled.",
  ];
  out.emit({
    type: "done",
    message: stripVTControlCharacters(lines.join("\n")),
    display: [lines[0], chalk.cyan(lines[1]!), chalk.dim(lines[2]!)].join("\n"),
    data: { organization: ws.organization, invitation: invitationData(invitation), url },
  });
}

export async function cancelInvitation(options: WorkspaceOptions, identifier: string): Promise<void> {
  const { out } = options;
  const { ws } = await connect(options);
  out.emit({ type: "step", step: STEP, status: "start", message: `Canceling the invitation for ${identifier}...` });
  const invitation = await workspace.uninvite(ws, identifier);
  out.emit({ type: "step", step: STEP, status: "ok", message: `Canceled ${invitation.email}'s invitation` });
  out.emit({
    type: "done",
    message: `Canceled ${invitation.email}'s invitation to ${ws.organization.name}. Its links no longer work.`,
    data: { organization: ws.organization, invitation: invitationData(invitation) },
  });
}

export async function deactivateMember(options: WorkspaceOptions, identifier: string): Promise<void> {
  const { out } = options;
  const { ws } = await connect(options);
  out.emit({ type: "step", step: STEP, status: "start", message: `Deactivating ${identifier}...` });
  const { member, already } = await workspace.deactivate(ws, identifier);
  out.emit({ type: "step", step: STEP, status: "ok", message: `Deactivated ${member.email}`, data: { userId: member.id, already } });
  const lines = already
    ? [`${member.email} was deactivated already.`, "Their sessions, tokens and AI connections are revoked again, in case any came back."]
    : [
        `Deactivated ${member.email}.`,
        "They can't sign in anywhere on this Gateway; their sessions are ended and their personal access tokens and AI connections revoked.",
        `${CLI} workspace reactivate ${member.email} lets them back in (revoked tokens and connections stay revoked).`,
      ];
  out.emit({
    type: "done",
    message: lines.join("\n"),
    display: [lines[0], ...lines.slice(1).map((line) => chalk.dim(line))].join("\n"),
    data: { organization: ws.organization, member: memberData(member), already },
  });
}

export async function reactivateMember(options: WorkspaceOptions, identifier: string): Promise<void> {
  const { out } = options;
  const { ws } = await connect(options);
  out.emit({ type: "step", step: STEP, status: "start", message: `Reactivating ${identifier}...` });
  const { member, already } = await workspace.reactivate(ws, identifier);
  out.emit({ type: "step", step: STEP, status: "ok", message: `Reactivated ${member.email}`, data: { userId: member.id, already } });
  const lines = already
    ? [`${member.email} was active already. Nothing changed.`]
    : [`Reactivated ${member.email}.`, "They can sign in again. Tokens and AI connections revoked at deactivation stay revoked: they make new ones."];
  out.emit({
    type: "done",
    message: lines.join("\n"),
    display: [lines[0], ...lines.slice(1).map((line) => chalk.dim(line))].join("\n"),
    data: { organization: ws.organization, member: memberData(member), already },
  });
}

export async function removeMember(
  options: WorkspaceOptions<WorkspaceFlags & { yes?: boolean }>,
  identifier: string,
): Promise<void> {
  const { out, flags } = options;
  const { gateway, ws } = await connect(options);
  const member = await workspace.findMember(ws, identifier);
  await confirmUnlessYes({
    yes: flags.yes,
    interactive: interactiveIn(options),
    confirm: options.confirm,
    question: `Remove ${member.email} from ${ws.organization.name}?`,
    unattended: "Removing a member needs confirmation at a terminal, or --yes",
    context: [
      "Their membership, app grants, group places, tokens and AI connections for the organization go;",
      "their account too, when it belongs to no other organization.",
    ],
    cancelled: "Cancelled. Nothing removed.",
    data: { userId: member.id, email: member.email },
  });
  out.emit({ type: "step", step: STEP, status: "start", message: `Removing ${member.email}...` });
  const hosted = gateway.install.deploymentMode === "hosted";
  const result = await workspace.remove(ws, member.id, {
    deleteAccounts: !hosted,
    // The values of these settings are Worker secrets the CLI can't read:
    // either one set means Access may let them back in, so the Gateway's
    // own rule (deactivate instead) is applied to the safe side.
    accessMayLetBackIn: async () => {
      const names = await listWorkerSecrets(gateway.cf, GATEWAY_WORKER_NAME);
      return ACCESS_AUTO_JOIN_SETTINGS.some((name) => names.includes(name));
    },
  });
  out.emit({
    type: "step",
    step: STEP,
    status: "ok",
    message: result.deactivatedInstead ? `Deactivated ${member.email} instead` : `Removed ${member.email}`,
    data: { userId: member.id, deactivatedInstead: result.deactivatedInstead, accountDeleted: result.accountDeleted },
  });
  const lines = result.deactivatedInstead
    ? [
        `Deactivated ${member.email} instead of removing them.`,
        `The Gateway has ${listed(ACCESS_AUTO_JOIN_SETTINGS)} or one of them set, so Cloudflare Access may let them straight back in with a new account; a deactivation keeps them out. They stay listed.`,
        `To delete the account anyway, unset the setting first (${CLI} secret unset <NAME>) and run this again.`,
      ]
    : [
        `Removed ${member.email} from ${ws.organization.name}.`,
        "Their grants and group places went with the membership; their tokens for it and AI connections to it are revoked.",
        result.accountDeleted
          ? "Their account is deleted: it belonged to no other organization."
          : result.otherOrganizations > 0
            ? `Their account stays: they belong to ${plural(result.otherOrganizations, "other organization")}.`
            : "Their account stays: this Gateway keeps accounts.",
      ];
  out.emit({
    type: "done",
    message: lines.join("\n"),
    display: [lines[0], ...lines.slice(1).map((line) => chalk.dim(line))].join("\n"),
    data: {
      organization: ws.organization,
      member: memberData(result.member),
      deactivatedInstead: result.deactivatedInstead,
      accountDeleted: result.accountDeleted,
      otherOrganizations: result.otherOrganizations,
    },
  });
}

export async function passwordResetLink(options: WorkspaceOptions, identifier: string): Promise<void> {
  const { out } = options;
  const { ws, gatewayUrl } = await connect(options);
  const { member, token, expiresAt } = await workspace.resetLink(ws, identifier);
  const url = workspace.passwordResetUrl(gatewayUrl, token);
  const lines = [
    `A password-reset link for ${member.email} (single use; expires ${when(expiresAt)} UTC):`,
    `  ${url}`,
    "Whoever opens it sets the account's password: hand it to them yourself.",
  ];
  out.emit({
    type: "done",
    message: stripVTControlCharacters(lines.join("\n")),
    display: [lines[0], chalk.cyan(lines[1]!), chalk.dim(lines[2]!)].join("\n"),
    data: { organization: ws.organization, member: memberData(member), url, expiresAt: iso(expiresAt) },
  });
}
