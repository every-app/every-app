import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/middleware/auth";
import { publicErrorMiddleware } from "@/middleware/publicError";
import { McpConnectionService } from "@/server/services/McpConnectionService";

const revokeConnectionSchema = z.object({
  connectionId: z.string().min(1).max(64),
});

/** The AI apps the signed-in user connected, in every organization. */
export const listMyMcpConnections = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, authMiddleware])
  .handler(async ({ context }) => {
    return McpConnectionService.listForUser(context.user.id);
  });

export const revokeMyMcpConnection = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, authMiddleware])
  .validator((data: unknown) => revokeConnectionSchema.parse(data))
  .handler(async ({ data, context }) => {
    return McpConnectionService.revokeForUser(
      context.user.id,
      data.connectionId,
    );
  });
