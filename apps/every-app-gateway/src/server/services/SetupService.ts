import { logEvent } from "@every-app/perimeter";
import { createAuth } from "@/auth";
import { PublicError } from "@/server/errors";
import {
  claimOwnerBootstrap,
  clearStaleOwnerBootstrap,
  hasAnyOwnerMembership,
  releaseOwnerBootstrap,
} from "@/server/organization/owner-membership";
import { OrganizationRepository } from "../repositories/OrganizationRepository";
import { OwnerSetupTokenRepository } from "../repositories/OwnerSetupTokenRepository";
import { UserRepository } from "../repositories/UserRepository";
import {
  SETUP_TOKEN_PREFIX,
  digestsEqual,
  hashSetupToken,
} from "../setup-token";
import { AppAccessService } from "./AppAccessService";

type SetupErrorCode =
  | "INVALID_OR_EXPIRED_SETUP_LINK"
  | "ALREADY_CLAIMED"
  | "CLAIM_IN_PROGRESS";

const SETUP_ERRORS: Record<
  SetupErrorCode,
  { status: 403 | 409 | 503; message: string }
> = {
  INVALID_OR_EXPIRED_SETUP_LINK: {
    status: 403,
    message: "This setup link is invalid, expired or already used.",
  },
  ALREADY_CLAIMED: {
    status: 409,
    message: "This gateway already has an owner.",
  },
  // Retryable: the setup page tries again after a delay.
  CLAIM_IN_PROGRESS: {
    status: 503,
    message: "Another setup attempt is still running. Try again shortly.",
  },
};

/** A rejected claim. Every bad-link case maps to one public code. */
export class SetupError extends Error {
  readonly code: SetupErrorCode;
  readonly status: 403 | 409 | 503;

  constructor(code: SetupErrorCode) {
    super(SETUP_ERRORS[code].message);
    this.name = "SetupError";
    this.code = code;
    this.status = SETUP_ERRORS[code].status;
  }
}

type ClaimOwnerInput = {
  token: string;
  name: string;
  email: string;
  password: string;
};

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

/**
 * The active claim link matching `token`, compared in constant time against
 * every live link so a near-miss reveals nothing.
 */
async function findClaimLink(token: string): Promise<{ id: string } | null> {
  if (!token.startsWith(SETUP_TOKEN_PREFIX)) return null;
  const tokenHash = await hashSetupToken(token);
  const active = await OwnerSetupTokenRepository.findActiveClaims();
  let match: { id: string } | null = null;
  for (const link of active) {
    if (digestsEqual(link.tokenHash, tokenHash)) match = { id: link.id };
  }
  return match;
}

/**
 * Create the gateway's first owner, organization and membership from a
 * one-time setup link. Until this succeeds the gateway is closed: sign-up
 * needs an invitation and nobody can create an organization.
 *
 * The bootstrap singleton lets only one claim run at a time, and the link is
 * consumed (guarded, so at most once) as the last step. If anything fails
 * first, the new user is removed and the bootstrap released, so the same link
 * can be retried. A claim killed mid-way (CPU limit) skips that cleanup; its
 * bootstrap row goes stale after two minutes and a retry then clears it.
 * Until then a claim gets CLAIM_IN_PROGRESS (503), which the setup page
 * retries, rather than being told an owner exists when none does.
 */
async function claimOwner(input: ClaimOwnerInput) {
  const link = await findClaimLink(input.token);
  if (!link) {
    logEvent("setup.claim_rejected", { reason: "invalid_or_expired" });
    throw new SetupError("INVALID_OR_EXPIRED_SETUP_LINK");
  }
  if (await hasAnyOwnerMembership()) {
    throw new SetupError("ALREADY_CLAIMED");
  }

  const email = input.email.trim().toLowerCase();
  const staleSince = await clearStaleOwnerBootstrap();
  if (staleSince) {
    await UserRepository.deleteUnaffiliatedByEmail(email, staleSince);
  }

  if (!(await claimOwnerBootstrap())) {
    // Another claim holds the bootstrap: either it finished (an owner
    // exists), or it is running or died part-way and has not gone stale yet.
    throw new SetupError(
      (await hasAnyOwnerMembership()) ? "ALREADY_CLAIMED" : "CLAIM_IN_PROGRESS",
    );
  }

  const auth = createAuth();
  let createdUserId: string | null = null;
  let createdOrganizationId: string | null = null;
  try {
    // A server-side call (no request), so the invite-only sign-up hook
    // lets it through; over HTTP sign-up always needs an invitation.
    const result = await auth.api.signUpEmail({
      body: { name: input.name.trim(), email, password: input.password },
    });

    if (!result.user) {
      throw new Error("Failed to create owner account");
    }

    // With autoSignIn off, Better Auth answers a sign-up for an email that
    // already has an account with a synthetic user (random id, nothing
    // written) instead of an error, so confirm the row really exists.
    if (!(await UserRepository.findById(result.user.id))) {
      throw new PublicError(
        "USER_ALREADY_EXISTS",
        "An account with this email already exists.",
      );
    }

    createdUserId = result.user.id;

    const slug =
      slugify(result.user.name || "") ||
      slugify(email.split("@")[0] || "org") ||
      "org";

    // A system action (userId, no session): allowed even though members
    // cannot create organizations.
    const organization = await auth.api.createOrganization({
      body: {
        name: result.user.name?.trim() || "My Organization",
        slug,
        userId: result.user.id,
      },
    });

    if (!organization) {
      throw new Error("Failed to create organization");
    }
    createdOrganizationId = organization.id;

    await AppAccessService.grantDefaultAppsToUser(
      result.user.id,
      organization.id,
    );
    if (!(await OwnerSetupTokenRepository.consume(link.id, result.user.id))) {
      throw new SetupError("INVALID_OR_EXPIRED_SETUP_LINK");
    }

    logEvent("setup.claimed", {
      userId: result.user.id,
      organizationId: organization.id,
    });
    return { userId: result.user.id, organizationId: organization.id };
  } catch (error) {
    if (createdOrganizationId) {
      await OrganizationRepository.deleteById(createdOrganizationId);
    }
    if (createdUserId) {
      await UserRepository.deleteById(createdUserId);
    }
    await releaseOwnerBootstrap();
    throw error;
  }
}

export const SetupService = {
  claimOwner,
} as const;
