/**
 * `everyapp workspace rename <name>`: the workspace's name, written on the
 * install's organization row in the Gateway's D1 under the Cloudflare
 * login (lib/gateway/workspace.ts), the way `provider on` writes its
 * rows. The name follows the rule the Gateway's own rename applies
 * (`validOrganizationName` in `@every-app/sdk/internal`), checked before
 * anything is read, so a refused name costs no login. Nothing is built,
 * uploaded or deployed; the Gateway reads the row live and each member
 * sees the name on their next page.
 */
import { stripVTControlCharacters } from "node:util";
import { MAX_ORGANIZATION_NAME_LENGTH, validOrganizationName } from "@every-app/sdk/internal";
import chalk from "chalk";
import type { CfRunner } from "@/lib/cf/runner";
import { EveryAppError } from "@/lib/errors";
import { connectToGateway, requestedGatewayUrl } from "@/lib/gateway/connect";
import { renameInstallOrganization } from "@/lib/gateway/workspace";
import type { EventSink } from "@/lib/output/events";
import { canPromptInTerminal } from "@/lib/output/prompt";
import { runCommand } from "@/lib/output/run";
import type { GatewayCommandFlags } from "../flags";

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

function connect({ flags, out, createCf }: WorkspaceOptions) {
  return connectToGateway({
    gateway: requestedGatewayUrl(flags.gateway),
    accountId: flags["account-id"],
    interactive: canPromptInTerminal(flags.json ?? false),
    login: { json: flags.json, out, step: "login" },
    createCf,
  });
}

const STEP = "workspace.rename";

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
  out.emit({ type: "step", step: STEP, status: "start", message: "Renaming the workspace..." });
  const { organization, previousName, changed } = await renameInstallOrganization(gateway.db, name);
  out.emit({
    type: "step",
    step: STEP,
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
