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
  /**
   * Customer code in a dispatch namespace, through the deploy API
   * (server/deploy/): the launch gate. Hosted only, and only while the
   * THIRD_PARTY_DEPLOYS secret is exactly "on". It stays off until the
   * isolation set (limits and the Outbound default-deny on every dispatch,
   * the deployer's binding allowlist and its read-back), identities minted
   * for the Worker's name (aud = workerName), per-host sessions on the
   * separate third-party domain and the egress default-deny are verified
   * against a live namespace. Off, the deploy API's routes don't exist.
   */
  readonly thirdPartyDeploys: boolean;
  /**
   * What a third-party app's Worker gets: its CPU and subrequests per
   * invocation (set on the script and on every dispatch), and how many
   * Durable Object classes it may define.
   */
  readonly thirdPartyLimits: {
    readonly cpuMs: number;
    readonly subrequests: number;
    readonly durableObjectClasses: number;
  };
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
  /**
   * Emails a UTC day, per kind of mail, to one address and from the whole
   * gateway (server/email/sendEmail.ts): what a sign-up form, a resend
   * button or a careless admin can make the gateway send, and so what they
   * can do to its sender reputation.
   */
  readonly mailDaily: Readonly<Record<MailKind, MailBudget>>;
}

/** The mail the gateway sends, each kind with its own daily budgets. */
export type MailKind = "verification" | "reset" | "invitation";

interface MailBudget {
  readonly perAddress: number;
  readonly perGateway: number;
}

interface PlatformPolicyEnv {
  GATEWAY_DEPLOYMENT_MODE?: string;
  AI_PROXY_ORG_DAILY_LIMIT?: string;
  INTEGRATION_ORG_DAILY_LIMIT?: string;
  HOSTED_OPEN_SIGNUP?: string;
  THIRD_PARTY_DEPLOYS?: string;
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

/**
 * Whether the hosted gateway lets anyone sign up: yes unless the operator
 * set HOSTED_OPEN_SIGNUP to something other than "true" ("false" keeps the
 * preview invite-only), so a typo closes sign-up rather than opening it.
 */
function hostedOpenSignUp(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  return !value || value === "true";
}

function mailBudgets(
  perAddress: number,
  perGateway: Record<MailKind, number>,
): Record<MailKind, MailBudget> {
  return {
    verification: { perAddress, perGateway: perGateway.verification },
    reset: { perAddress, perGateway: perGateway.reset },
    invitation: { perAddress, perGateway: perGateway.invitation },
  };
}

/**
 * Generous enough for a server-rendered page with a few database calls
 * (getAppFetcher's dispatch default), and room for a chat and a scratchpad
 * class; never more than this until metering exists.
 */
const THIRD_PARTY_LIMITS = {
  cpuMs: 5_000,
  subrequests: 200,
  durableObjectClasses: 2,
};
const NO_THIRD_PARTY = { cpuMs: 0, subrequests: 0, durableObjectClasses: 0 };

function freeze(policy: PlatformPolicy): PlatformPolicy {
  Object.freeze(policy.orgDailyCaps);
  Object.freeze(policy.thirdPartyLimits);
  Object.freeze(policy.dcr);
  for (const budget of Object.values(policy.mailDaily)) Object.freeze(budget);
  Object.freeze(policy.mailDaily);
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
        thirdPartyLimits: { ...NO_THIRD_PARTY },
        tenantAdminUserActions: true,
        bindingActivation: true,
        orgDailyCaps: {
          aiProxyRequests: Infinity,
          integrationProxyRequests: Infinity,
        },
        dcr: { perAddress: 20, perGateway: 200 },
        // An operator's own members: far above what an install sends, so
        // only a loop or a script ever meets them.
        mailDaily: mailBudgets(10, {
          verification: 1_000,
          reset: 1_000,
          invitation: 1_000,
        }),
      });
    case "hosted":
      return freeze({
        mode,
        hosted: true,
        openSignUp: hostedOpenSignUp(env.HOSTED_OPEN_SIGNUP),
        personalOrgs: true,
        requireEmailVerification: true,
        accessSignIn: false,
        setupClaim: true,
        platformOrganizationName: "Every App",
        sharedApps: true,
        // Exactly "on": a typo, or anything else, keeps the gate shut.
        thirdPartyDeploys: env.THIRD_PARTY_DEPLOYS === "on",
        thirdPartyLimits: { ...THIRD_PARTY_LIMITS },
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
        // Anyone can type an address into the sign-up or resend form: a
        // few mails a day reach any one address, whoever asks.
        mailDaily: mailBudgets(5, {
          verification: 2_000,
          reset: 1_000,
          invitation: 2_000,
        }),
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
        thirdPartyLimits: { ...NO_THIRD_PARTY },
        tenantAdminUserActions: false,
        bindingActivation: false,
        orgDailyCaps: { aiProxyRequests: 0, integrationProxyRequests: 0 },
        dcr: { perAddress: 0, perGateway: 0 },
        mailDaily: mailBudgets(0, { verification: 0, reset: 0, invitation: 0 }),
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
