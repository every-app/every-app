import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { imageRequestSchema } from "@/server/utils/validation";
import { withAuth, errorResponse } from "@/server/utils/api";

export const Route = createFileRoute("/api/image")({
  server: {
    handlers: {
      GET: withAuth(async ({ request, userId }) => {
        try {
          // Validate and parse request parameters
          const url = new URL(request.url);
          const key = url.searchParams.get("key");

          const validationResult = imageRequestSchema.safeParse({ key });

          if (!validationResult.success) {
            const firstError = validationResult.error.issues[0];
            return errorResponse(firstError?.message || "Invalid input", 400);
          }

          const validatedKey = validationResult.data.key;

          // Extract userId from the key (format: userId/chatId/fileId.ext)
          const keyParts = validatedKey.split("/");
          if (keyParts.length < 3) {
            return errorResponse("Invalid key format", 400);
          }

          const keyUserId = keyParts[0];

          // Security: Verify that the authenticated user owns this image
          if (keyUserId !== userId) {
            return errorResponse("Forbidden", 403);
          }

          // Get the object from R2
          const object = await env.R2.get(validatedKey);

          if (!object) {
            return errorResponse("Image not found", 404);
          }

          // Return the image with appropriate headers
          return new Response(object.body, {
            headers: {
              "Content-Type": object.httpMetadata?.contentType || "image/jpeg",
              "Cache-Control": "public, max-age=31536000, immutable",
            },
          });
        } catch (error) {
          console.error("Image retrieval error:", error);
          return errorResponse("Failed to retrieve image", 500);
        }
      }),
    },
  },
});
