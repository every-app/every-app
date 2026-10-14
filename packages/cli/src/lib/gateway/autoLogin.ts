/**
 * Logging the CLI in once the owner claims the gateway. `everyapp setup`
 * mints the setup link with a second secret it keeps (lib/gateway/
 * pendingClaims.ts); with it, the gateway hands over the owner's first
 * deploy token, once, after the claim. No one copies a token anywhere, and
 * whoever sees the link can't do the same.
 */
import { ActionRequiredError, EveryAppError } from "@/lib/errors";
import { GatewayApiError, GatewayClient } from "./api";
import { writeGatewayCredential } from "./credentials";
import { deletePendingClaim, type PendingClaim } from "./pendingClaims";

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_INTERVAL_MS = 2_000;

interface OwnerLogin {
  organizationId: string;
  organizationName: string;
  /** Who claimed the link: the owner the deploy token acts for. */
  ownerEmail: string | null;
}

/** "Logged in to <gateway> as <email> (owner of <organization>)." */
export function describeOwnerLogin(
  gatewayUrl: string,
  login: OwnerLogin,
): string {
  return login.ownerEmail
    ? `Logged in to ${gatewayUrl} as ${login.ownerEmail} (owner of ${login.organizationName}).`
    : `Logged in to ${gatewayUrl} for ${login.organizationName}.`;
}

/** A setup link, as the gateway answers this CLI's secret for it. */
type SetupLinkState =
  /** Nobody has used it yet, or the gateway didn't answer (not reachable yet). */
  | { status: "waiting" }
  /** It was claimed: this CLI is logged in now. */
  | { status: "logged_in"; login: OwnerLogin }
  /**
   * The gateway has no token for it (404): it expired, or a newer link
   * replaced it, before anyone used it; or its token was handed out
   * already, or not fetched within 30 minutes of the claim.
   */
  | { status: "gone" };

type SetupDeployTokenClient = Pick<GatewayClient, "setupDeployToken">;

/**
 * Ask the gateway about the link once. A claimed link's deploy token is
 * stored like `everyapp login` does; the pending claim is forgotten once
 * the link is claimed, or gone.
 */
export async function checkSetupLink({
  claim,
  client = new GatewayClient({ gatewayUrl: claim.gatewayUrl }),
}: {
  claim: PendingClaim;
  client?: SetupDeployTokenClient;
}): Promise<SetupLinkState> {
  const host = new URL(claim.gatewayUrl).host;
  let answer;
  try {
    answer = await client.setupDeployToken(claim.cliSecret);
  } catch (error) {
    if (error instanceof GatewayApiError && error.status === 404) {
      await deletePendingClaim(host);
      return { status: "gone" };
    }
    // Something in front of the gateway answers instead (Cloudflare Access
    // sending to its login page): waiting won't change that.
    if (
      error instanceof GatewayApiError &&
      (error.code === "ACCESS_IN_FRONT" || error.code === "GATEWAY_REDIRECTED")
    ) {
      throw error;
    }
    // Not reachable yet (no certificate, or DNS still on its way): wait.
    return { status: "waiting" };
  }
  if (!("token" in answer)) return { status: "waiting" };
  await writeGatewayCredential({
    gatewayUrl: claim.gatewayUrl,
    token: answer.token,
    organizationId: answer.organizationId,
  });
  await deletePendingClaim(host);
  return {
    status: "logged_in",
    login: {
      organizationId: answer.organizationId,
      organizationName: answer.organizationName,
      ownerEmail: answer.ownerEmail ?? null,
    },
  };
}

/**
 * Ask every two seconds, for up to ten minutes, until the link is claimed
 * or gone (checkSetupLink). Still `waiting` when time ran out: the claim
 * may still come, so run it again.
 */
export async function waitForOwnerLogin({
  claim,
  client = new GatewayClient({ gatewayUrl: claim.gatewayUrl }),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
}: {
  claim: PendingClaim;
  client?: SetupDeployTokenClient;
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<SetupLinkState> {
  const deadline = now() + timeoutMs;
  for (;;) {
    const state = await checkSetupLink({ claim, client });
    if (state.status !== "waiting" || now() >= deadline) return state;
    await sleep(intervalMs);
  }
}

/**
 * What to do once a setup link's login is gone, by whether the gateway
 * has its owner (null: couldn't tell). With one, the login was used or
 * its 30 minutes passed: sign in for a deploy token. Without one, nobody
 * used the link before it expired or a newer one replaced it (`gateway
 * claim-link`, or a setup or deploy elsewhere): get a new link.
 */
export function setupLinkGone(
  gatewayUrl: string,
  hasOwner: boolean | null,
): Error {
  const signIn = `Sign in at ${gatewayUrl}, create a deploy token under Admin → Tokens, and run \`everyapp login\`.`;
  const newLink =
    "Run `everyapp setup` again for a new link (or `everyapp gateway claim-link` on a machine logged in to the gateway's Cloudflare account).";
  if (hasOwner === false) {
    return new ActionRequiredError(
      "claim_owner",
      `The setup link stopped working before anyone used it: a newer one replaced it (\`everyapp gateway claim-link\`, or a setup or deploy on another machine), or it expired. If someone has the newer link, create the owner account with it. Otherwise: ${newLink}`,
    );
  }
  if (hasOwner === true) {
    return new EveryAppError(
      "SETUP_LOGIN_EXPIRED",
      `The setup link's login was used already, or expired (it waits 30 minutes after the claim). ${signIn}`,
    );
  }
  return new EveryAppError(
    "SETUP_LOGIN_EXPIRED",
    `The setup link's login is gone: it was used already or expired, or a newer link replaced it. If the owner account exists: ${signIn} If not: ${newLink}`,
  );
}
