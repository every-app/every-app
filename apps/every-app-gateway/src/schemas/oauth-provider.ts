import { z } from "zod";
import { PROVIDER_ID, SCOPE_SET_NAME } from "@every-app/sdk/internal";

/**
 * What Admin → Providers and Settings → Connected accounts send
 * (docs/design/2026-10-oauth-providers.md sections 4, 5 and 9). A client
 * id or secret is bounded by length only: the provider decides its shape.
 * The spec of a custom provider is parsed by the registry's parser on the
 * server, so it is `unknown` here.
 */

export const OAUTH_CLIENT_ID_MAX = 512;
export const OAUTH_CLIENT_SECRET_MAX = 4096;

const providerId = z
  .string()
  .regex(PROVIDER_ID, "A provider id is lowercase letters, digits and dashes.");

const clientId = z
  .string()
  .trim()
  .min(1, "Enter the client id.")
  .max(OAUTH_CLIENT_ID_MAX, "The client id is too long.");

const clientSecret = z
  .string()
  .min(1, "Enter the client secret.")
  .max(OAUTH_CLIENT_SECRET_MAX, "The client secret is too long.");

export const addOAuthProviderSchema = z
  .object({
    /** A preset id (`github-oauth`) or a catalog OAuth entry (`google-workspace`). */
    preset: z.string().regex(PROVIDER_ID).optional(),
    /** A custom provider's spec (section 3 of the design). */
    spec: z.record(z.string(), z.unknown()).optional(),
    clientId: clientId.optional(),
    clientSecret: clientSecret.optional(),
  })
  .refine((value) => (value.preset ? !value.spec : Boolean(value.spec)), {
    message: "Choose a preset or describe a custom provider, not both.",
    path: ["preset"],
  })
  .refine((value) => !(value.clientSecret && !value.clientId), {
    message: "A client secret needs its client id.",
    path: ["clientId"],
  });

export const setOAuthClientSchema = z.object({
  providerId,
  clientId,
  clientSecret: clientSecret.optional(),
});

export const providerActionSchema = z.object({ providerId });

export const disconnectConnectionSchema = z.object({
  providerId,
  account: z.enum(["user", "organization"]),
  /** Another member's connection (owners and admins); absent: the caller's own. */
  userId: z.string().min(1).max(128).optional(),
});

export type AddOAuthProviderInput = z.infer<typeof addOAuthProviderSchema>;

const scopeSetName = z
  .string()
  .trim()
  .regex(
    SCOPE_SET_NAME,
    "A set is named identity, or <area>.<access> in lowercase (gmail.send).",
  );

/**
 * A scope set added to a built-in OAuth client (Admin → Providers → Scope
 * sets): the set's fields as the dialog takes them; the registry's parser
 * checks them on the server (routes on the client's hosts, anchored posts).
 */
export const addScopeSetSchema = z.object({
  providerId,
  name: scopeSetName,
  label: z
    .string()
    .trim()
    .min(1, "Label the set.")
    .max(80, "The label is too long."),
  access: z.enum(["read", "write"]),
  scopes: z
    .array(z.string().trim().min(1).max(200))
    .min(1, "Name at least one scope."),
  routes: z
    .array(
      z.object({
        host: z.string().trim().min(1).max(253),
        paths: z
          .array(z.string().trim().min(1).max(500))
          .min(1, "Name at least one path."),
        posts: z.array(z.string().trim().min(1).max(500)).optional(),
      }),
    )
    .min(1, "Name at least one route the set unlocks."),
});

export const removeScopeSetSchema = z.object({
  providerId,
  name: scopeSetName,
});

export type AddScopeSetInput = z.infer<typeof addScopeSetSchema>;
