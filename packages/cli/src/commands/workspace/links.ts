/**
 * `everyapp workspace reset-link <email>` and `workspace invite-link
 * <email|id>`: the operator's two links (lib/gateway/recovery.ts), the
 * workspace commands that write the Gateway's D1 under the Cloudflare login
 * instead of calling its tools, which never hand a link to their caller.
 */
import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";
import type { CfRunner } from "@/lib/cf/runner";
import { connectToGateway, requestedGatewayUrl } from "@/lib/gateway/connect";
import { mintInvitationLink, mintRecoveryLink } from "@/lib/gateway/recovery";
import { canPromptInTerminal } from "@/lib/output/prompt";
import type { EventSink } from "@/lib/output/events";
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

/** The link's `done`: a line, the link in cyan, and a dim note. */
function emitLink(out: EventSink, lines: [string, string, string], data: Record<string, unknown>): void {
  out.emit({
    type: "done",
    message: stripVTControlCharacters(lines.join("\n")),
    display: [lines[0], chalk.cyan(lines[1]), chalk.dim(lines[2])].join("\n"),
    data,
  });
}

async function printResetLink(options: LinkOptions, email: string): Promise<void> {
  const gateway = await connect(options);
  const link = await mintRecoveryLink(gateway.db, gateway.gatewayUrl, email, options.now);
  emitLink(
    options.out,
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
