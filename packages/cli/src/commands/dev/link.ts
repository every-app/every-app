/**
 * `everyapp dev link` and `everyapp dev unlink`: sign `everyapp dev` in to
 * a Gateway for the app in this directory without running it (so the
 * browser step happens when you choose), and sign it out again (the grant
 * is revoked at the Gateway and the token forgotten). `everyapp dev
 * --gateway <url>` links on its own when it has no token.
 */
import { gatewayOrigin, linkGateway, unlinkGateway } from "@/lib/linkedDev";
import { EveryAppError } from "@/lib/errors";
import { loadEveryAppManifest } from "@/lib/manifest";
import { CLI } from "@/lib/output/command";
import { runCommand } from "@/lib/output/run";

interface LinkFlags {
  gateway?: string;
  app?: string;
  json?: boolean;
  verbose?: boolean;
}

/** `--gateway`, else EVERYAPP_GATEWAY_URL; `--app`, else the manifest in this directory. */
async function target(flags: LinkFlags, cwd: string): Promise<{ gateway: string; appId: string }> {
  const gateway = flags.gateway ?? process.env["EVERYAPP_GATEWAY_URL"];
  if (!gateway) {
    throw new EveryAppError(
      "LINKED_DEV_GATEWAY_REQUIRED",
      "Which Gateway?\nPass --gateway https://<your gateway>, or set EVERYAPP_GATEWAY_URL.",
      { data: { fix: "pass --gateway <url>" } },
    );
  }
  const appId = flags.app ?? (await loadEveryAppManifest(cwd)).id;
  return { gateway: gatewayOrigin(gateway), appId };
}

export async function link(flags: LinkFlags): Promise<void> {
  await runCommand(flags, async (out) => {
    const { gateway, appId } = await target(flags, process.cwd());
    const session = await linkGateway({ gateway, appId, out, fresh: true, json: flags.json });
    const who = await session.whoami();
    out.emit({
      type: "done",
      message: `Linked ${CLI} dev to ${gateway} as ${who.user.email} (${who.role} of ${who.organization.name}) for ${who.app.name}`,
      data: {
        gateway,
        appId,
        email: who.user.email,
        role: who.role,
        organization: who.organization,
        app: who.app,
        connectionId: who.connection.id,
      },
    });
  });
}

export async function unlink(flags: LinkFlags): Promise<void> {
  await runCommand(flags, async (out) => {
    const { gateway, appId } = await target(flags, process.cwd());
    const entry = await unlinkGateway({ gateway, appId, out });
    out.emit({
      type: "done",
      message: entry
        ? `${CLI} dev is signed out of ${gateway} for ${appId}`
        : `${CLI} dev wasn't linked to ${gateway} for ${appId}; nothing to forget`,
      data: { gateway, appId, unlinked: Boolean(entry) },
    });
  });
}
