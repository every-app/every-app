import type { LocalContext } from "@/context";
import enquirer from "enquirer";
import { findGatewayUrl } from "@/lib/gateway/resolve";
import { GatewayClient } from "@/lib/gateway/api";
import { ActionRequiredError, EveryAppError } from "@/lib/errors";
import {
  checkSetupLink,
  describeOwnerLogin,
  setupLinkGone,
  waitForOwnerLogin,
} from "@/lib/gateway/autoLogin";
import {
  normalizeGatewayUrl,
  writeGatewayCredential,
} from "@/lib/gateway/credentials";
import {
  listPendingClaims,
  readPendingClaim,
  type PendingClaim,
} from "@/lib/gateway/pendingClaims";
import type { EventSink } from "@/lib/output/events";
import { eventSink, runReported } from "@/lib/output/run";

async function getDefaultGatewayUrl(): Promise<string> {
  try {
    return (await findGatewayUrl()) ?? "";
  } catch {
    return "";
  }
}

interface LoginFlags {
  resume?: boolean;
  gateway?: string;
}

export async function login(
  this: LocalContext,
  flags: LoginFlags = {},
): Promise<void> {
  const out = eventSink();
  await runReported(out, () =>
    flags.resume ? resumeLogin(flags.gateway, out) : storeDeployToken(out),
  );
}

/** `everyapp login`: a deploy token pasted at the terminal. */
async function storeDeployToken(out: EventSink): Promise<void> {
  const defaultGatewayUrl = await getDefaultGatewayUrl();
  const { gatewayUrl: rawGatewayUrl } = await enquirer.prompt<{
    gatewayUrl: string;
  }>({
    type: "input",
    name: "gatewayUrl",
    message: "Gateway URL",
    initial: defaultGatewayUrl,
    validate: (value: string) => {
      try {
        normalizeGatewayUrl(value.trim());
        return true;
      } catch {
        return "Enter a valid gateway URL";
      }
    },
  });

  const gatewayUrl = normalizeGatewayUrl(rawGatewayUrl.trim());
  const { token } = await enquirer.prompt<{ token: string }>({
    type: "password",
    name: "token",
    message: "Deploy token",
    validate: (value: string) => {
      if (!value.trim().startsWith("eak_")) {
        return "Deploy tokens start with eak_";
      }

      return true;
    },
  });

  const client = new GatewayClient({
    gatewayUrl,
    getAuthToken: async () => token.trim(),
  });
  const whoami = await client.whoami();

  await writeGatewayCredential({
    gatewayUrl,
    token: token.trim(),
    organizationId: whoami.organizationId,
  });

  out.emit({
    type: "done",
    message: `Logged in to ${gatewayUrl} for ${whoami.organizationName} (${whoami.organizationId}).`,
    data: { gatewayUrl, organizationId: whoami.organizationId },
  });
}

/**
 * `everyapp login --resume`: finish the login an interrupted `everyapp
 * setup` was waiting for, with the secret it kept for its setup link.
 */
async function resumeLogin(
  gatewayFlag: string | undefined,
  out: EventSink,
): Promise<void> {
  const claims = gatewayFlag
    ? [await readPendingClaim(new URL(normalizeGatewayUrl(gatewayFlag)).host)].filter(
        (claim): claim is PendingClaim => claim !== null,
      )
    : await listPendingClaims();
  if (claims.length === 0) {
    throw new EveryAppError(
      "NO_PENDING_SETUP",
      `No setup on this machine is waiting for its owner${gatewayFlag ? ` at ${gatewayFlag}` : ""} (or its link expired). Run \`everyapp setup\`, or create a deploy token under Admin → Tokens and run \`everyapp login\`.`,
    );
  }
  if (claims.length > 1) {
    throw new EveryAppError(
      "GATEWAY_REQUIRED",
      `Several setups are waiting (${claims.map((claim) => claim.gatewayUrl).join(", ")}); pass --gateway <url>.`,
    );
  }
  const claim = claims[0]!;
  const client = new GatewayClient({ gatewayUrl: claim.gatewayUrl });
  // The link is shown only while the gateway still waits on it.
  let state = await checkSetupLink({ claim, client });
  if (state.status === "waiting") {
    out.emit({
      type: "action_required",
      action: "claim_owner",
      message:
        "Waiting for the owner account to be created with this setup link...",
      data: { url: claim.url, expiresAt: claim.expiresAt, waiting: true },
    });
    state = await waitForOwnerLogin({ claim, client });
  }
  if (state.status === "gone") {
    throw setupLinkGone(
      claim.gatewayUrl,
      await client.hasOwner().catch(() => null),
    );
  }
  if (state.status === "waiting") {
    throw new ActionRequiredError(
      "claim_owner",
      "Nobody has finished the setup link yet: open it, then run `everyapp login --resume` again.",
      claim.url,
    );
  }
  // Who claimed the link, so a person can tell it was who they expected.
  const { login } = state;
  out.emit({
    type: "done",
    message: describeOwnerLogin(claim.gatewayUrl, login),
    data: {
      gatewayUrl: claim.gatewayUrl,
      organizationId: login.organizationId,
      organizationName: login.organizationName,
      ownerEmail: login.ownerEmail,
    },
  });
}
