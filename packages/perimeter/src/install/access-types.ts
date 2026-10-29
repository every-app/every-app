import { z } from "zod";
export type AccessRule = Record<string, unknown>;
const OverrideOutput = z.looseObject({
  path_pattern: z.string(),
  behavior: z.string(),
});

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
  oauth_configuration: z
    .looseObject({ enabled: z.boolean().nullish() })
    .nullish(),
});
export type AccessApplication = z.infer<typeof ApplicationOutput>;

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
