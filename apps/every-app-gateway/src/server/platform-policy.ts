/**
 * What this gateway does, decided once from GATEWAY_DEPLOYMENT_MODE
 * (server/deployment-mode.ts, ADR-0001). One codebase serves both shapes:
 *
 *  - `self_hosted`: an operator's own install. Invite-only sign-up, the
 *    setup claim makes the first owner and the install organization,
 *    Cloudflare Access sign-in when configured, tenant admins manage their
 *    members' accounts.
 *  - `hosted`: our own install of the same gateway with hosted rules. Open
 *    sign-up into personal organizations with verified email, shared
 *    first-party apps, no Access sign-in, and tenant admins can't act on
 *    accounts (an account spans organizations nobody in one of them owns).
 *    The setup claim still makes the first owner, whose organization is the
 *    platform organization.
 *  - `invalid` (unset included): every capability off, hosted and
 *    self-hosted alike, so a gateway whose mode was lost or mistyped
 *    fails closed instead of guessing.
 *
 * The policy is plain data (no functions that read env later): callers ask
 * for it per use, with the env they have.
 */
import { resolveDeploymentMode } from "@/server/deployment-mode";

interface PlatformPolicy {
  readonly mode: "self_hosted" | "hosted" | "invalid";
  readonly hosted: boolean;
  /** Anyone may create an account; otherwise only with an invite link. */
  readonly openSignUp: boolean;
  /** Each new account gets an organization of its own, as its owner. */
  readonly personalOrgs: boolean;
  /** An account signs in only once its email is verified. */
  readonly requireEmailVerification: boolean;
  /**
   * Cloudflare Access sign-in (OIDC and the outer ring) is registered when
   * configured. Off: its settings are ignored and the plugin is absent.
   */
  readonly accessSignIn: boolean;
  /** The one-time setup link makes the first owner and their organization. */
  readonly setupClaim: boolean;
  /**
   * What the setup claim names the install organization: on the hosted
   * gateway it is the platform organization, "Every App"; null names it
   * after the owner.
   */
  readonly platformOrganizationName: string | null;
  /** Apps any member of any active organization may open (first-party). */
  readonly sharedApps: boolean;
  /** Customer code in a dispatch namespace: a launch gate, off tonight. */
  readonly thirdPartyDeploys: boolean;
  /**
   * Organization admins may deactivate, reactivate, reset the password of
   * and delete the accounts of their members.
   */
  readonly tenantAdminUserActions: boolean;
  /**
   * The gateway marks a `binding` app `active` once it reaches the app's
   * Worker over a service binding (server/app-activation.ts).
   */
  readonly bindingActivation: boolean;
  /**
   * Requests per organization per UTC day through the AI proxy and the
   * integration proxy. Infinity: no cap.
   */
  readonly orgDailyCaps: {
    readonly aiProxyRequests: number;
    readonly integrationProxyRequests: number;
  };
  /**
   * Dynamic client registrations (/oauth/register) per UTC day, per client
   * address and for the whole gateway (server/mcp-auth/registration-limit.ts).
   */
  readonly dcr: { readonly perAddress: number; readonly perGateway: number };
}

interface PlatformPolicyEnv {
  GATEWAY_DEPLOYMENT_MODE?: string;
  AI_PROXY_ORG_DAILY_LIMIT?: string;
  INTEGRATION_ORG_DAILY_LIMIT?: string;
}

const HOSTED_AI_PROXY_ORG_DAILY_LIMIT = 200;
const HOSTED_INTEGRATION_ORG_DAILY_LIMIT = 500;

/**
 * A daily cap from its env override: a whole number of requests, or the
 * default when unset. Anything else is 0, so a typo stops traffic rather
 * than lifting the cap.
 */
function dailyLimit(raw: string | undefined, fallback: number): number {
  const value = raw?.trim();
  if (!value) return fallback;
  return /^\d+$/.test(value) ? Number(value) : 0;
}

function freeze(policy: PlatformPolicy): PlatformPolicy {
  Object.freeze(policy.orgDailyCaps);
  Object.freeze(policy.dcr);
  return Object.freeze(policy);
}

export function platformPolicy(env: PlatformPolicyEnv): PlatformPolicy {
  const mode = resolveDeploymentMode(env.GATEWAY_DEPLOYMENT_MODE);
  switch (mode) {
    case "self_hosted":
      return freeze({
        mode,
        hosted: false,
        openSignUp: false,
        personalOrgs: false,
        requireEmailVerification: false,
        accessSignIn: true,
        setupClaim: true,
        platformOrganizationName: null,
        sharedApps: false,
        thirdPartyDeploys: false,
        tenantAdminUserActions: true,
        bindingActivation: true,
        orgDailyCaps: {
          aiProxyRequests: Infinity,
          integrationProxyRequests: Infinity,
        },
        dcr: { perAddress: 20, perGateway: 200 },
      });
    case "hosted":
      return freeze({
        mode,
        hosted: true,
        openSignUp: true,
        personalOrgs: true,
        requireEmailVerification: true,
        accessSignIn: false,
        setupClaim: true,
        platformOrganizationName: "Every App",
        sharedApps: true,
        thirdPartyDeploys: false,
        tenantAdminUserActions: false,
        bindingActivation: true,
        orgDailyCaps: {
          aiProxyRequests: dailyLimit(
            env.AI_PROXY_ORG_DAILY_LIMIT,
            HOSTED_AI_PROXY_ORG_DAILY_LIMIT,
          ),
          integrationProxyRequests: dailyLimit(
            env.INTEGRATION_ORG_DAILY_LIMIT,
            HOSTED_INTEGRATION_ORG_DAILY_LIMIT,
          ),
        },
        dcr: { perAddress: 200, perGateway: 20_000 },
      });
    default:
      return freeze({
        mode: "invalid",
        hosted: false,
        openSignUp: false,
        personalOrgs: false,
        requireEmailVerification: false,
        accessSignIn: false,
        setupClaim: false,
        platformOrganizationName: null,
        sharedApps: false,
        thirdPartyDeploys: false,
        tenantAdminUserActions: false,
        bindingActivation: false,
        orgDailyCaps: { aiProxyRequests: 0, integrationProxyRequests: 0 },
        dcr: { perAddress: 0, perGateway: 0 },
      });
  }
}

/** What the sign-in pages may know of the policy (it is public). */
export interface PublicPolicy {
  /** `open`: anyone may sign up; `invitation`: only with an invite link. */
  signUp: "open" | "invitation";
  /** A new account must verify its email before it signs in. */
  emailVerification: boolean;
}

export function describePolicy(policy: PlatformPolicy): PublicPolicy {
  return {
    signUp: policy.openSignUp ? "open" : "invitation",
    emailVerification: policy.requireEmailVerification,
  };
}
