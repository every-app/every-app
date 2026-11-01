import { z } from "zod";

/**
 * The consent page's form (routes/oauth/consent.tsx) as it posts to
 * /oauth/consent/decision: the field names both sides use, and the parser
 * the decision reads it with.
 */
export const CONSENT_FIELDS = {
  handle: "handle",
  decision: "decision",
  // What the page showed, checked against the stored request.
  clientId: "client_id",
  redirectUri: "redirect_uri",
  organizationId: "organization_id",
  appMode: "app_mode",
  appIds: "app_ids",
  access: "access",
  // The grant's resource (RFC 8707) the page showed: `${issuer}/mcp`, or an
  // app host's origin for a native app (docs/design/native-sign-in.md §6).
  // Checked against the stored request, as client_id is.
  resource: "resource",
} as const;

const decisionSchema = z.object({
  handle: z.string().min(1).max(512),
  decision: z.enum(["approve", "deny"]),
  client_id: z.string().min(1).max(2048),
  redirect_uri: z.string().min(1).max(2048),
  organization_id: z.string().max(256).optional(),
  app_mode: z.enum(["all", "selected"]).default("all"),
  app_ids: z.array(z.string().min(1).max(256)).max(500).default([]),
  // Least privilege when the form says nothing.
  access: z.enum(["write", "read"]).default("read"),
  resource: z.string().min(1).max(2048).optional(),
});

export type ConsentDecision = z.infer<typeof decisionSchema>;

/** The consent form, or null when it isn't one the page could have sent. */
export function parseDecisionForm(form: FormData): ConsentDecision | null {
  const value = (name: string) => {
    const field = form.get(name);
    return typeof field === "string" ? field : undefined;
  };
  const parsed = decisionSchema.safeParse({
    handle: value(CONSENT_FIELDS.handle),
    decision: value(CONSENT_FIELDS.decision),
    client_id: value(CONSENT_FIELDS.clientId),
    redirect_uri: value(CONSENT_FIELDS.redirectUri),
    organization_id: value(CONSENT_FIELDS.organizationId),
    app_mode: value(CONSENT_FIELDS.appMode),
    app_ids: form
      .getAll(CONSENT_FIELDS.appIds)
      .filter((field): field is string => typeof field === "string"),
    access: value(CONSENT_FIELDS.access),
    resource: value(CONSENT_FIELDS.resource),
  });
  return parsed.success ? parsed.data : null;
}
