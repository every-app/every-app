import { z } from "zod";

export const createAppTokenSchema = z.object({
  tokenType: z.literal("deploy"),
  expiresAt: z
    .string()
    .datetime("Invalid expiration date")
    .nullable()
    .optional(),
});

export const revokeAppTokenSchema = z.object({
  tokenId: z.string().uuid("Invalid token ID"),
});
