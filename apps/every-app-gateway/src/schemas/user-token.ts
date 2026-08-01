import { z } from "zod";

const scopeRegex = /^[a-z0-9][a-z0-9:_-]{0,63}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_MS = 365 * DAY_MS;

const userTokenScopeSchema = z
  .string()
  .regex(scopeRegex, "Invalid scope")
  .refine((scope) => !scope.startsWith("provider:"), {
    message: "provider scopes are not allowed",
  });

const expiresAtSchema = z
  .string()
  .datetime("Invalid expiration date")
  .refine(
    (value) => {
      const time = new Date(value).getTime();
      const now = Date.now();
      return time >= now + DAY_MS && time <= now + YEAR_MS;
    },
    {
      message: "Expiration must be between 1 day and 1 year from now",
    },
  );

export const createUserTokenSchema = z.object({
  name: z.string().trim().min(1).max(64),
  scopes: z.array(userTokenScopeSchema).max(20).optional(),
  appId: z.string().uuid("Invalid app ID").optional(),
  expiresAt: expiresAtSchema.optional(),
});

export const revokeUserTokenSchema = z.object({
  tokenId: z.string().uuid("Invalid token ID"),
});
