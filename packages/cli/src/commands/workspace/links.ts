/**
 * `everyapp workspace reset-link <email>` and `workspace invite-link
 * <email|id>`: the operator's two links (lib/gateway/recovery.ts), the
 * workspace commands that write the Gateway's D1 under the Cloudflare login
 * instead of calling its tools, which never hand a link to their caller.
 */
import chalk from "chalk";
import type { CfRunner } from "@/lib/cf/runner";
import { connectToGateway, requestedGatewayUrl } from "@/lib/gateway/connect";
import { mintInvitationLink, mintRecoveryLink } from "@/lib/gateway/recovery";
import { canPromptInTerminal } from "@/lib/output/prompt";
import type { EventSink } from "@/lib/output/events";
import { finish } from "@/lib/output/result";
import { runCommand } from "@/lib/output/run";
import type { GatewayCommandFlags } from "../flags";

interface LinkOptions {
  flags: GatewayCommandFlags;
  out: EventSink;
  createCf?: (accountId?: string) => CfRunner;
  now?: number;
}

export async function resetLink(flags: GatewayCommandFlags, email: string): Promise<void> {
  await runCommand(flags, (out) => printResetLink({ flags, out }, email));
}

export async function inviteLink(flags: GatewayCommandFlags, invitation: string): Promise<void> {
  await runCommand(flags, (out) => printInviteLink({ flags, out }, invitation));
}

function connect(options: LinkOptions) {
  const { flags, out } = options;
  return connectToGateway({
    gateway: requestedGatewayUrl(flags.gateway),
    accountId: flags["account-id"],
    interactive: canPromptInTerminal(flags.json ?? false),
    login: { json: flags.json, out, step: "login" },
    createCf: options.createCf,
  });
}

const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/**
 * The link's `done` (docs/cli-output.md): what the link is, the link on a
 * line of its own, then what to do with it. `lines` is the account a
 * script gets; its last sentence shows with --verbose.
 */
function emitLink(
  out: EventSink,
  short: { headline: string; url: string; note: string; detail: string },
  lines: [string, string, string],
  data: Record<string, unknown>,
): void {
  finish(out, {
    headline: short.headline,
    blocks: [[chalk.cyan(short.url)], [chalk.dim(short.note)]],
    message: lines,
    detail: [short.detail],
    data,
  });
}

async function printResetLink(options: LinkOptions, email: string): Promise<void> {
  const gateway = await connect(options);
  const link = await mintRecoveryLink(gateway.db, gateway.gatewayUrl, email, options.now);
  emitLink(
    options.out,
    {
      headline: `Password-reset link for ${link.member.email}`,
      url: link.url,
      note: `Single use, expires ${when(link.expiresAt)} UTC. Hand it to them yourself.`,
      detail: "Whoever opens it sets the account's password.",
    },
    [
      `A password-reset link for ${link.member.email} (single use; expires ${when(link.expiresAt)} UTC):`,
      `  ${link.url}`,
      "Whoever opens it sets the account's password: hand it to them yourself.",
    ],
    {
      organization: link.organization,
      member: link.member,
      url: link.url,
      expiresAt: new Date(link.expiresAt).toISOString(),
    },
  );
}

async function printInviteLink(options: LinkOptions, invitation: string): Promise<void> {
  const gateway = await connect(options);
  const link = await mintInvitationLink(gateway.db, gateway.gatewayUrl, invitation, options.now);
  emitLink(
    options.out,
    {
      headline: `New invitation link for ${link.invitation.email} to ${link.organization.name}`,
      url: link.url,
      note: `Expires ${when(link.expiresAt)} UTC. Hand it to them yourself.`,
      detail: "Earlier links keep working until the invitation is accepted or canceled.",
    },
    [
      `A new link for ${link.invitation.email}'s invitation to ${link.organization.name} (expires ${when(link.expiresAt)} UTC):`,
      `  ${link.url}`,
      "Hand it to them yourself. Earlier links keep working until the invitation is accepted or canceled.",
    ],
    {
      organization: link.organization,
      invitation: link.invitation,
      url: link.url,
      expiresAt: new Date(link.expiresAt).toISOString(),
    },
  );
}
