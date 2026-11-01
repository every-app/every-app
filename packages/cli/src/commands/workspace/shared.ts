/**
 * What every `everyapp workspace …` handler shares: the flags, the seams
 * tests use, the connection (the Gateway through the Cloudflare login,
 * then the organization `--org` names or the install one), and how rows
 * are said to a person.
 */
import chalk from "chalk";
import type { CfRunner } from "@/lib/cf/runner";
import { EveryAppError } from "@/lib/errors";
import { connectToGateway, requestedGatewayUrl } from "@/lib/gateway/connect";
import {
  findMember,
  openWorkspace,
  type WorkspaceInvitation,
  type WorkspaceMember,
  type Workspace,
} from "@/lib/gateway/workspace";
import type { EventSink } from "@/lib/output/events";
import { canPromptInTerminal, type Confirm } from "@/lib/output/prompt";
import type { OrganizationCommandFlags } from "../flags";

/** The flags every workspace command takes. */
export type WorkspaceFlags = OrganizationCommandFlags;

/** What the handlers take from the command line, and the seams tests use. */
export interface WorkspaceOptions<F extends WorkspaceFlags = WorkspaceFlags> {
  flags: F;
  out: EventSink;
  /** cf per account (tests). */
  createCf?: (accountId?: string) => CfRunner;
  now?: () => number;
  /** Whether a person is at the terminal (default: canPromptInTerminal); tests. */
  interactive?: boolean;
  /** The confirmation prompt (tests). */
  confirm?: Confirm;
}

/** The Gateway (through the login) and the organization a command acts on. */
interface Connected {
  gateway: Awaited<ReturnType<typeof connectToGateway>>;
  ws: Workspace;
  gatewayUrl: string;
}

export async function connect(options: WorkspaceOptions): Promise<Connected> {
  const { flags, out, createCf } = options;
  const gateway = await connectToGateway({
    gateway: requestedGatewayUrl(flags.gateway),
    accountId: flags["account-id"],
    interactive: canPromptInTerminal(flags.json ?? false),
    login: { json: flags.json, out, step: "login" },
    createCf,
  });
  const ws = await openWorkspace(gateway.db, gateway.deployer, {
    org: flags.org,
    now: options.now?.(),
  });
  return { gateway, ws, gatewayUrl: gateway.gatewayUrl };
}

/** Whether a person is at the terminal, unless a test says. */
export function interactiveIn(options: WorkspaceOptions): boolean {
  return options.interactive ?? canPromptInTerminal(options.flags.json ?? false);
}

/** Whom `--user` names on a trail: a member, or, by id, someone who has since left. */
interface UserFilter {
  id: string;
  email: string | null;
  /** A member of the organization now; false for an id the trails still carry. */
  member: boolean;
}

/**
 * `--user` on `activity`, `tokens` and `connections`: a member by email or
 * id; failing that, an id as it is, since the trails keep a person's rows
 * after they leave (named by id, as the Gateway's Activity page shows
 * them). An email that is nobody's is refused: nothing is keyed by it.
 */
export async function userFilter(ws: Workspace, value: string): Promise<UserFilter> {
  try {
    const member = await findMember(ws, value);
    return { id: member.id, email: member.email, member: true };
  } catch (error) {
    if (!(error instanceof EveryAppError) || error.code !== "USER_NOT_FOUND" || value.includes("@")) throw error;
    return { id: value.trim(), email: null, member: false };
  }
}

/** A `--user` in a headline: their email, or the id of someone who has left. */
export const userLabel = (user: UserFilter): string =>
  user.member ? (user.email ?? user.id) : `${user.id} (no longer a member)`;

/** A time as a person reads it in a table: "2026-10-24 09:15". */
export function when(ms: number | null): string {
  if (ms === null) return chalk.dim("never");
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

/** A time for `data`: ISO, or null. */
export const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** A member's state in a table. */
export function memberState(member: WorkspaceMember): string {
  return member.deactivated ? chalk.yellow("deactivated") : chalk.green("active");
}

/** A member for `data`: what every list carries about one. */
export function memberData(member: WorkspaceMember) {
  return {
    id: member.id,
    email: member.email,
    name: member.name,
    role: member.primaryRole ?? member.role,
    deactivated: member.deactivated,
    createdAt: iso(member.createdAt),
  };
}

/** An invitation for `data`. */
export function invitationData(invitation: WorkspaceInvitation) {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    status: invitation.status,
    expiresAt: iso(invitation.expiresAt),
    expired: !invitation.live && invitation.status === "pending",
    createdAt: iso(invitation.createdAt),
  };
}

/** `--add`, `--remove` and `--set` as the lib takes them; refused together. */
export function listChange(flags: { add?: string[]; remove?: string[]; set?: string[] }): {
  change: { add?: string[]; remove?: string[]; set?: string[] } | null;
} {
  const { add, remove, set } = flags;
  if (set && (add || remove)) {
    throw new EveryAppError(
      "FLAGS_CONFLICT",
      "--set replaces the whole list: give it alone, or --add and --remove without it",
    );
  }
  if (!add && !remove && !set) return { change: null };
  return { change: { add, remove, set } };
}
