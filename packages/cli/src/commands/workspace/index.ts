/**
 * `everyapp workspace …`: the install's workspace (the Gateway's own
 * organization, the one its owner claimed), written in the Gateway's D1
 * under the Cloudflare login, the way `mcp on` writes its rows. Nothing is
 * built, uploaded or deployed: the Gateway reads the rows live.
 *
 * `workspace rename <name>` writes the organization's name
 * (lib/gateway/workspace.ts) by the rule the Gateway's own rename applies
 * (`validOrganizationName` in `@every-app/sdk/internal`), checked before
 * anything is read, so a refused name costs no login; each member sees the
 * name on their next page.
 *
 * `workspace role <email> <owner|admin|member>` sets a member's role
 * (lib/gateway/members.ts), for when the Gateway's own Users page isn't the
 * way: the only owner is locked out, or a script sets up a team. The rule
 * is the Gateway's (MembershipService): owners are peers, and the
 * workspace always keeps at least one who can act, so an owner's role is
 * never changed while no other owner is live. The Gateway reads a role
 * change within 30 seconds.
 */
import { stripVTControlCharacters } from "node:util";
import { MAX_ORGANIZATION_NAME_LENGTH, validOrganizationName } from "@every-app/sdk/internal";
import chalk from "chalk";
import type { CfRunner } from "@/lib/cf/runner";
import { EveryAppError } from "@/lib/errors";
import { connectToGateway, requestedGatewayUrl } from "@/lib/gateway/connect";
import { setMemberRole } from "@/lib/gateway/members";
import { installOrganization } from "@/lib/gateway/registry";
import { renameInstallOrganization } from "@/lib/gateway/workspace";
import { CLI } from "@/lib/output/command";
import { ticked, type EventSink } from "@/lib/output/events";
import { canPromptInTerminal } from "@/lib/output/prompt";
import { runCommand } from "@/lib/output/run";
import type { GatewayCommandFlags } from "../flags";
import type { WorkspaceRole } from "./command";

/** What the handlers take from the command line, and the seams tests use. */
export interface WorkspaceOptions {
  flags: GatewayCommandFlags;
  out: EventSink;
  /** cf per account (tests). */
  createCf?: (accountId?: string) => CfRunner;
}

export async function rename(flags: GatewayCommandFlags, name: string): Promise<void> {
  await runCommand(flags, (out) => renameWorkspace({ flags, out }, name));
}

export async function role(flags: GatewayCommandFlags, email: string, role: WorkspaceRole): Promise<void> {
  await runCommand(flags, (out) => setRole({ flags, out }, email, role));
}

function connect({ flags, out, createCf }: WorkspaceOptions) {
  return connectToGateway({
    gateway: requestedGatewayUrl(flags.gateway),
    accountId: flags["account-id"],
    interactive: canPromptInTerminal(flags.json ?? false),
    login: { json: flags.json, out, step: "login" },
    createCf,
  });
}

const RENAME_STEP = "workspace.rename";

/** `workspace rename`: the rule, the Gateway, the row, one `done`. */
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
  const gateway = await connect(options);
  out.emit({ type: "step", step: RENAME_STEP, status: "start", message: "Renaming the workspace..." });
  const { organization, previousName, changed } = await renameInstallOrganization(gateway.db, name);
  out.emit({
    type: "step",
    step: RENAME_STEP,
    status: "ok",
    message: changed ? `Renamed ${previousName} to ${name}` : `${name} already`,
    data: { id: organization.id, name, previousName, changed },
  });
  const headline = changed
    ? `Renamed the workspace to ${name}.`
    : `The workspace is named ${name} already.`;
  const note = changed
    ? "Members see the name on their next page."
    : "Nothing changed.";
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

const ROLE_STEP = "workspace.role";

/** "an owner", "an admin", "a member". */
const withArticle = (role: string) => `${/^[aeiou]/.test(role) ? "an" : "a"} ${role}`;

/** `workspace role`: the Gateway, the member, the guarded row, one `done`. */
export async function setRole(options: WorkspaceOptions, email: string, role: WorkspaceRole): Promise<void> {
  const { out } = options;
  const address = email.trim().toLowerCase();
  const gateway = await connect(options);
  const found = await installOrganization(gateway.db);
  if (!found) {
    throw new EveryAppError(
      "MEMBER_NOT_FOUND",
      "This Gateway has no workspace yet\nNobody has claimed its owner link, so it has no members.",
      { rerun: `${CLI} setup`, rerunNote: "to claim it" },
    );
  }
  const { organization } = found;
  const workspace = { id: organization.id, name: organization.name };
  out.emit({ type: "step", step: ROLE_STEP, status: "start", message: `Setting ${address}'s role...` });
  const result = await setMemberRole(gateway.db, organization.id, address, role);
  if (result.kind === "not_found") {
    throw new EveryAppError(
      "MEMBER_NOT_FOUND",
      `No member ${address} in ${organization.name}\nSomeone still invited isn't a member until they accept.`,
      {
        fix: "check the address against Manage workspace → Users, or invite them first",
        data: { workspace, email: address },
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
        data: { workspace, member, role },
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
      workspace,
      member,
      role,
      changed,
      ...(changed ? { previousRole: result.previousRole } : {}),
    },
  });
}
