/**
 * `everyapp dev token` — print an identity token the app accepts under
 * `everyapp dev`, for scripts that call the app's internal dev port
 * directly as someone other than the gateway-lite's seeded user (a member,
 * an admin, another organization).
 *
 * The token is minted exactly as the gateway-lite mints the one it injects
 * (packages/perimeter/src/dev/devGateway.ts): the SDK's well-known dev key,
 * the dev kid, the dev issuer, `aud` = the app id, channel `web`, scopes `["*"]`
 * (a full session). Nothing here can produce a token a deployed app takes:
 * the SDK accepts the dev kid only in a Worker that `everyAppWorker()` built
 * for development (EVERYAPP_DEV) and only from the dev issuer.
 */
import { DEV_USER } from "@every-app/perimeter/dev";
import { DEV_ISSUER, DEV_PRIVATE_KEY_PEM } from "@every-app/sdk/dev";
import {
  IDENTITY_DEV_KEY_ID,
  IDENTITY_HEADER,
  mintIdentityJwt,
  type IdentitySubject,
} from "@every-app/sdk/internal";
import { loadEveryAppManifest } from "@/lib/manifest";
import { EveryAppError } from "@/lib/errors";
import { CLI } from "@/lib/output/command";
import { runCommand } from "@/lib/output/run";
import {
  DEFAULT_DEV_TOKEN_TTL_SECONDS,
  type DevTokenRole,
} from "./tokenFlags";

/**
 * Who the token speaks for. Without --user, an owner is the gateway-lite's
 * seeded dev user; an admin or member is a person of their own
 * (`admin@everyapp.localhost`, sub `dev-admin`), so the seeded owner keeps
 * its role in an app that mirrors users. With --user, the sub is derived
 * from the email, the same for every run.
 */
function devTokenSubject(options: {
  role: DevTokenRole;
  email?: string;
  orgId?: string;
}): IdentitySubject {
  const orgId = options.orgId ?? DEV_USER.orgId;
  if (options.email) {
    const sub = options.email === DEV_USER.email ? DEV_USER.sub : `dev-${options.email}`;
    return { sub, email: options.email, orgId, orgRole: options.role };
  }
  if (options.role === "owner") return { ...DEV_USER, orgId, orgRole: "owner" };
  return {
    sub: `dev-${options.role}`,
    email: `${options.role}@everyapp.localhost`,
    orgId,
    orgRole: options.role,
  };
}

interface DevToken {
  token: string;
  /** ISO 8601. */
  expiresAt: string;
  /** The request header the app reads it from. */
  header: string;
  appId: string;
  user: IdentitySubject;
}

/** Mint the token; `now` and the subject's parts for tests. */
export async function mintDevToken(options: {
  appId: string;
  role?: DevTokenRole;
  email?: string;
  orgId?: string;
  ttlSeconds?: number;
  now?: number;
}): Promise<DevToken> {
  const now = options.now ?? Date.now();
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_DEV_TOKEN_TTL_SECONDS;
  const user = devTokenSubject({
    role: options.role ?? "owner",
    email: options.email,
    orgId: options.orgId,
  });
  const token = await mintIdentityJwt(DEV_PRIVATE_KEY_PEM, {
    subject: user,
    audience: options.appId,
    issuer: DEV_ISSUER,
    channel: "web",
    keyId: IDENTITY_DEV_KEY_ID,
    ttlSeconds,
    now,
  });
  const issuedAt = Math.floor(now / 1000);
  return {
    token,
    expiresAt: new Date((issuedAt + ttlSeconds) * 1000).toISOString(),
    header: IDENTITY_HEADER,
    appId: options.appId,
    user,
  };
}

interface DevTokenFlags {
  role: DevTokenRole;
  user?: string;
  org?: string;
  app?: string;
  ttl?: number;
  json?: boolean;
}

export default async function devToken(flags: DevTokenFlags): Promise<void> {
  await runCommand(flags, async (out) => {
    const appId = flags.app ?? (await appIdHere(process.cwd()));
    const minted = await mintDevToken({
      appId,
      role: flags.role,
      email: flags.user,
      orgId: flags.org,
      ttlSeconds: flags.ttl,
    });
    // A person (or `$(…)`) gets the token alone on stdout; --json the whole of it.
    out.emit({
      type: "done",
      message: `Dev identity token for ${appId} as ${minted.user.email} (${minted.user.orgRole} of ${minted.user.orgId}), until ${minted.expiresAt}`,
      display: minted.token,
      data: { ...minted },
    });
  });
}

async function appIdHere(cwd: string): Promise<string> {
  try {
    return (await loadEveryAppManifest(cwd)).id;
  } catch (error) {
    if (error instanceof EveryAppError && error.code === "MANIFEST_NOT_FOUND") {
      throw new EveryAppError("MANIFEST_NOT_FOUND", error.message, {
        fix: `run this from the app's directory, or name the app: ${CLI} dev token --app <id>`,
      });
    }
    throw error;
  }
}
