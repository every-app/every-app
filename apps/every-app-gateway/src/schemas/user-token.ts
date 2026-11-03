import { z } from "zod";
import { TOKEN_ACCESS, TOKEN_EXPIRY_DAYS } from "@/server/user-pat-scopes";

export const createUserTokenSchema = z.object({
  name: z.string().trim().min(1).max(64),
  access: z.enum(TOKEN_ACCESS),
  appId: z.string().uuid("Invalid app ID").optional(),
  expiresInDays: z.literal(TOKEN_EXPIRY_DAYS),
});

export const revokeUserTokenSchema = z.object({
  tokenId: z.string().uuid("Invalid token ID"),
});
