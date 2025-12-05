import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { IMAGE_CONSTRAINTS } from "@/server/utils/constants";
import { MessageRepository } from "@/server/repositories/MessageRepository";
import { withAuth, errorResponse, jsonResponse } from "@/server/utils/api";

export const Route = createFileRoute("/api/upload")({
  server: {
    handlers: {
      POST: withAuth(async ({ request, userId }) => {
        try {
          // Parse FormData
          const formData = await request.formData();
          const imageFile = formData.get("file");
          const chatId = formData.get("chatId");

          if (!imageFile || !(imageFile instanceof File)) {
            return errorResponse("No file provided", 400);
          }

          if (!chatId || typeof chatId !== "string") {
            return errorResponse("Chat ID is required", 400);
          }

          // Verify chat ownership
          const hasAccess = await MessageRepository.verifyChatOwnership(
            chatId,
            userId,
          );

          if (!hasAccess) {
            return errorResponse("Unauthorized: Chat access denied", 403);
          }

          // Validate file type against whitelist
          if (
            !IMAGE_CONSTRAINTS.ALLOWED_TYPES.includes(
              imageFile.type as (typeof IMAGE_CONSTRAINTS.ALLOWED_TYPES)[number],
            )
          ) {
            return errorResponse("Invalid file type", 400);
          }

          if (imageFile.size > IMAGE_CONSTRAINTS.MAX_SIZE_BYTES) {
            return errorResponse("File too large", 400);
          }

          // Generate key
          const fileId = crypto.randomUUID();
          const extension = imageFile.name.split(".").pop() || "jpg";
          const r2Key = `${userId}/${chatId}/${fileId}.${extension}`;

          // Upload to R2
          const arrayBuffer = await imageFile.arrayBuffer();
          await env.R2.put(r2Key, arrayBuffer, {
            httpMetadata: {
              contentType: imageFile.type,
            },
          });

          // Create file record in database
          await MessageRepository.createFile(
            userId,
            r2Key,
            imageFile.type,
            imageFile.size,
          );

          return jsonResponse({ key: r2Key });
        } catch (error) {
          console.error("Upload error:", error);
          return errorResponse("Failed to upload file", 500);
        }
      }),
    },
  },
});
