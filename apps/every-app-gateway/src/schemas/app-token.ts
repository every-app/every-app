import { z } from "zod";

const providerScopeRegex = /^provider:[a-z0-9-]+$|^provider:\*$/;

export const createAppTokenSchema = z.object({
  appId: z.string().uuid("Invalid app ID"),
  scopes: z
    .array(
      z
        .string()
        .min(1, "Scope is required")
        .regex(
          providerScopeRegex,
          'Scope must match "provider:<name>" or "provider:*"',
        ),
    )
    .min(1, "At least one scope is required")
    .max(20, "No more than 20 scopes are allowed"),
  expiresAt: z
    .string()
    .datetime("Invalid expiration date")
    .nullable()
    .optional(),
});

export const revokeAppTokenSchema = z.object({
  tokenId: z.string().uuid("Invalid token ID"),
});
