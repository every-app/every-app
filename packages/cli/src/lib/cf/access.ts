/**
 * Cloudflare Access (Zero Trust) through cf: the organization, identity
 * providers, reusable policies and applications that `everyapp access`
 * manages. Request bodies go to cf in a private file (`--body @<file>`),
 * and cf prints the API's result unwrapped. The shapes keep what the
 * command reads and tolerate the rest, so an application is updated by
 * sending back what was read (the API replaces it on PUT) with the fields
 * the command owns changed. Checked against cf@1.0.0-beta.14 and a live
 * account on 2026-10-23, except where a comment says otherwise.
 */
import { z } from "zod";
import { EveryAppError } from "@/lib/errors";
import { CfError, isCfError } from "./errors";
import { listAll, runCfJson, type CfRunner } from "./runner";

const PAGE = { perPage: 100, maxPages: 20 };

/** An Access call, its refusals said as everyapp's (`explainAccessError`). */
async function access<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (error) {
    throw explainAccessError(error);
  }
}

// --- Organization -----------------------------------------------------------

const OrganizationOutput = z.looseObject({
  name: z.string().nullish(),
  auth_domain: z.string(),
  /** How long tokens issued for applications are valid ("24h"); unset is the default. */
  session_duration: z.string().nullish(),
  allow_authenticate_via_warp: z.boolean().nullish(),
  deny_unmatched_requests: z.boolean().nullish(),
  deny_unmatched_requests_exempted_zone_names: z.array(z.string()).nullish(),
  warp_auth_non_browser_401: z.boolean().nullish(),
  mfa_config: z.unknown().nullish(),
});
export type AccessOrganization = z.infer<typeof OrganizationOutput>;

/**
 * The account's Zero Trust organization, or null when it has none (the API
 * answers 404; cf's box carries "404 Not Found", which the error parser
 * reads as `not_found`. Not yet seen live: every account checked had one.)
 */
export async function getAccessOrganization(cf: CfRunner): Promise<AccessOrganization | null> {
  try {
    return await runCfJson(
      cf,
      { plane: "account", args: ["zero-trust", "organization", "get"] },
      OrganizationOutput,
    );
  } catch (error) {
    if (isCfError(error, "not_found") || (error instanceof CfError && /not[_ ]found/i.test(error.message))) {
      return null;
    }
    throw explainAccessError(error);
  }
}

/** Create the organization. The auth domain is permanent once used. */
export function createAccessOrganization(
  cf: CfRunner,
  body: { name: string; auth_domain: string; session_duration: string },
): Promise<AccessOrganization> {
  return access(runCfJson(
    cf,
    {
      plane: "account",
      files: { "body.json": body },
      args: (files) => ["zero-trust", "organization", "create", "--body", `@${files["body.json"]!}`],
    },
    OrganizationOutput,
  ));
}

/**
 * Set the organization's global session duration. The API replaces the
 * organization on PUT, and refuses a body that carries some of what GET
 * returns (`is_ui_read_only`, `login_design`, `strict_service_token_auth`,
 * `service_token_inactivity`, `disable_end_user_app_creation`:
 * `access.api.error.invalid_org_config`, seen live), so the body is the
 * fields known to pass, as read, plus the change.
 */
export function setAccessOrganizationSession(
  cf: CfRunner,
  organization: AccessOrganization,
  sessionDuration: string,
): Promise<AccessOrganization> {
  const body = {
    name: organization.name ?? organization.auth_domain,
    auth_domain: organization.auth_domain,
    allow_authenticate_via_warp: organization.allow_authenticate_via_warp ?? false,
    deny_unmatched_requests: organization.deny_unmatched_requests ?? false,
    deny_unmatched_requests_exempted_zone_names:
      organization.deny_unmatched_requests_exempted_zone_names ?? [],
    warp_auth_non_browser_401: organization.warp_auth_non_browser_401 ?? false,
    ...(organization.mfa_config ? { mfa_config: organization.mfa_config } : {}),
    session_duration: sessionDuration,
  };
  return access(runCfJson(
    cf,
    {
      plane: "account",
      files: { "body.json": body },
      args: (files) => ["zero-trust", "organization", "update", "--body", `@${files["body.json"]!}`],
    },
    OrganizationOutput,
  ));
}

// --- Identity providers -----------------------------------------------------

const IdentityProviderOutput = z.looseObject({
  id: z.string(),
  /** "onetimepin", "cloudflare" (account members), "google-apps", "okta", "azureAD", … */
  type: z.string(),
  name: z.string().nullish(),
});
export type AccessIdentityProvider = z.infer<typeof IdentityProviderOutput>;

export function listAccessIdentityProviders(cf: CfRunner): Promise<AccessIdentityProvider[]> {
  return access(listAll(
    cf,
    ["zero-trust", "identity-providers", "list"],
    z.array(IdentityProviderOutput),
    PAGE,
  ));
}

/** The one-time PIN provider: a code emailed to the address the person types. */
export function createOneTimePinProvider(cf: CfRunner): Promise<AccessIdentityProvider> {
  return access(runCfJson(
    cf,
    {
      plane: "account",
      files: { "body.json": { name: "One-time PIN", type: "onetimepin", config: {} } },
      args: (files) => ["zero-trust", "identity-providers", "create", "--body", `@${files["body.json"]!}`],
    },
    IdentityProviderOutput,
  ));
}

// --- Reusable policies ------------------------------------------------------

/** One include/exclude/require rule, as the API keeps it (`{ email: { email } }`, …). */
export type AccessRule = Record<string, unknown>;

const PolicyOutput = z.looseObject({
  id: z.string(),
  name: z.string(),
  decision: z.string(),
  include: z.array(z.record(z.string(), z.unknown())).nullish(),
  exclude: z.array(z.record(z.string(), z.unknown())).nullish(),
  require: z.array(z.record(z.string(), z.unknown())).nullish(),
  reusable: z.boolean().nullish(),
});
export type AccessPolicy = z.infer<typeof PolicyOutput>;

export function listAccessPolicies(cf: CfRunner): Promise<AccessPolicy[]> {
  return access(listAll(cf, ["zero-trust", "access", "policies", "list"], z.array(PolicyOutput), PAGE));
}

export function createAccessPolicy(
  cf: CfRunner,
  body: { name: string; decision: "allow"; include: AccessRule[] },
): Promise<AccessPolicy> {
  return access(runCfJson(
    cf,
    {
      plane: "account",
      files: { "body.json": { ...body, exclude: [], require: [] } },
      args: (files) => ["zero-trust", "access", "policies", "create", "--body", `@${files["body.json"]!}`],
    },
    PolicyOutput,
  ));
}

/**
 * Delete a reusable policy; `--force` answers cf's confirmation. False when
 * it was gone already. Access refuses while an application still uses it,
 * so callers delete the applications first.
 */
export async function deleteAccessPolicy(cf: CfRunner, id: string): Promise<boolean> {
  try {
    await cf.run({
      plane: "account",
      mode: "json",
      args: ["zero-trust", "access", "policies", "delete", id, "--force"],
    });
    return true;
  } catch (error) {
    if (isCfError(error, "not_found")) return false;
    throw explainAccessError(error);
  }
}

/** What the API reports on a policy but won't take back on PUT. */
const POLICY_READ_ONLY_FIELDS = new Set(["id", "uid", "created_at", "updated_at", "app_count", "reusable"]);

/**
 * Replace the policy's rules. The API replaces the policy whole on PUT, so
 * the body is the policy as read (its session, approval and isolation
 * settings included) with `include` changed.
 */
export function updateAccessPolicyRules(
  cf: CfRunner,
  policy: AccessPolicy,
  include: AccessRule[],
): Promise<AccessPolicy> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(policy)) {
    if (!POLICY_READ_ONLY_FIELDS.has(key)) body[key] = value;
  }
  body["include"] = include;
  body["exclude"] = policy.exclude ?? [];
  body["require"] = policy.require ?? [];
  return access(runCfJson(
    cf,
    {
      plane: "account",
      files: { "body.json": body },
      args: (files) => [
        "zero-trust",
        "access",
        "policies",
        "update",
        policy.id,
        "--body",
        `@${files["body.json"]!}`,
      ],
    },
    PolicyOutput,
  ));
}

// --- Applications -----------------------------------------------------------

const OverrideOutput = z.looseObject({ path_pattern: z.string(), behavior: z.string() });

const DestinationOutput = z.looseObject({
  type: z.string().nullish(),
  uri: z.string().nullish(),
  overrides: z.array(OverrideOutput).nullish(),
});
export type AccessDestinationOutput = z.infer<typeof DestinationOutput>;

/** A policy as an application lists it: the reusable policy's id, in precedence order. */
const PolicyRefOutput = z.looseObject({
  id: z.string(),
  name: z.string().nullish(),
  precedence: z.number().nullish(),
  /** False for a policy that belongs to this application alone (inline); such an application takes no reusable one. */
  reusable: z.boolean().nullish(),
});

const ApplicationOutput = z.looseObject({
  id: z.string(),
  /** The Application Audience (AUD) tag: what CLOUDFLARE_ACCESS_AUD / _APPS_AUD take. */
  aud: z.string(),
  name: z.string().nullish(),
  type: z.string(),
  created_at: z.string().nullish(),
  destinations: z.array(DestinationOutput).nullish(),
  policies: z.array(PolicyRefOutput).nullish(),
  session_duration: z.string().nullish(),
  http_only_cookie_attribute: z.boolean().nullish(),
  enable_binding_cookie: z.boolean().nullish(),
  allowed_idps: z.array(z.string()).nullish(),
  auto_redirect_to_identity: z.boolean().nullish(),
  app_launcher_visible: z.boolean().nullish(),
  /** Managed OAuth (a beta): Access as the OAuth server AI apps talk to. */
  oauth_configuration: z.looseObject({ enabled: z.boolean().nullish() }).nullish(),
});
export type AccessApplication = z.infer<typeof ApplicationOutput>;

export function listAccessApplications(cf: CfRunner): Promise<AccessApplication[]> {
  return access(listAll(
    cf,
    ["zero-trust", "access", "applications", "list"],
    z.array(ApplicationOutput),
    PAGE,
  ));
}

/** What `create` sends; `update` sends the application as read with these changed. */
export interface AccessApplicationBody {
  name: string;
  type: "self_hosted";
  destinations: Array<{
    type: "public";
    uri: string;
    overrides: Array<{ path_pattern: string; behavior: "public" }>;
  }>;
  /** Reusable policy ids, in precedence order. */
  policies: string[];
  session_duration: string;
  http_only_cookie_attribute: boolean;
  enable_binding_cookie: boolean;
  allowed_idps?: string[];
  auto_redirect_to_identity?: boolean;
  app_launcher_visible?: boolean;
}

export function createAccessApplication(
  cf: CfRunner,
  body: AccessApplicationBody,
): Promise<AccessApplication> {
  return access(runCfJson(
    cf,
    {
      plane: "account",
      files: { "body.json": body },
      args: (files) => ["zero-trust", "access", "applications", "create", "--body", `@${files["body.json"]!}`],
    },
    ApplicationOutput,
  ));
}

/**
 * What the API gave with the application that it won't take back on PUT:
 * its identity and timestamps, the deprecated domain fields `destinations`
 * replaced, and `policies`, sent again as ids.
 */
const READ_ONLY_FIELDS = new Set([
  "id",
  "uid",
  "aud",
  "created_at",
  "updated_at",
  "domain",
  "self_hosted_domains",
  "policies",
  "scim_config",
]);

/** The application as read, as a PUT body, with `changes` applied. */
export function applicationUpdateBody(
  application: AccessApplication,
  changes: Partial<AccessApplicationBody>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(application)) {
    if (!READ_ONLY_FIELDS.has(key)) body[key] = value;
  }
  body["policies"] = [...(application.policies ?? [])]
    .sort((a, b) => (a.precedence ?? 0) - (b.precedence ?? 0))
    .map((policy) => policy.id);
  return { ...body, ...changes };
}

export function updateAccessApplication(
  cf: CfRunner,
  id: string,
  body: Record<string, unknown>,
): Promise<AccessApplication> {
  return access(runCfJson(
    cf,
    {
      plane: "account",
      files: { "body.json": body },
      args: (files) => [
        "zero-trust",
        "access",
        "applications",
        "update",
        id,
        "--body",
        `@${files["body.json"]!}`,
      ],
    },
    ApplicationOutput,
  ));
}

/** Delete an application; `--force` answers cf's confirmation. False when it was gone already. */
export async function deleteAccessApplication(cf: CfRunner, id: string): Promise<boolean> {
  try {
    await cf.run({
      plane: "account",
      mode: "json",
      args: ["zero-trust", "access", "applications", "delete", id, "--force"],
    });
    return true;
  } catch (error) {
    if (isCfError(error, "not_found")) return false;
    throw explainAccessError(error);
  }
}

/** Where an API token gets its permissions. */
const API_TOKENS_URL = "https://dash.cloudflare.com/profile/api-tokens";

/**
 * A cf refusal from these calls as everyapp says it: a login or token
 * without the Access permissions is `ACCESS_PERMISSION_MISSING` with what
 * to add; anything else is returned as it came, to rethrow. Only the
 * Access calls above go through it: a Workers or D1 refusal elsewhere in a
 * run is cf's own.
 */
function explainAccessError(error: unknown): unknown {
  if (isCfError(error, "auth")) {
    return new EveryAppError(
      "ACCESS_PERMISSION_MISSING",
      `This Cloudflare login can't manage Access\n${error.message.split("\n")[0]}`,
      {
        fix: "use a login or token with Access: Apps and Policies (edit) and Access: Organizations, Identity Providers, and Groups (edit)",
        data: { url: API_TOKENS_URL },
      },
    );
  }
  return error;
}
