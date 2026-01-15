import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { IMAGE_CONSTRAINTS } from "@/server/utils/constants";
import { MessageRepository } from "@/server/repositories/MessageRepository";
import { ChatRepository } from "@/server/repositories/ChatRepository";
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
            return errorResponse("Please select an image to upload", 400);
          }

          if (!chatId || typeof chatId !== "string") {
            return errorResponse("Unable to upload: chat not found", 400);
          }

          // Verify chat ownership
          const hasAccess = await ChatRepository.verifyChatOwnership(
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
            return errorResponse(
              "Please upload a JPEG, PNG, GIF, or WebP image",
              400,
            );
          }

          if (imageFile.size > IMAGE_CONSTRAINTS.MAX_SIZE_BYTES) {
            return errorResponse("Image must be smaller than 5MB", 400);
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
            r2Key,
            imageFile.type,
            imageFile.size,
          );

          return jsonResponse({ key: r2Key });
        } catch (error) {
          console.error("Upload error:", error);
          return errorResponse(
            "Failed to upload image. Please try again.",
            500,
          );
        }
      }),
    },
  },
});
