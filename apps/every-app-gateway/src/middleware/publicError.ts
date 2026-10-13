import { createMiddleware } from "@tanstack/react-start";
import { logEvent } from "@every-app/perimeter";
import {
  GatewayError,
  PublicError,
  getGatewayErrorCode,
  getPublicErrorCode,
} from "@/server/errors";
import { ZodError } from "zod";

export const publicErrorMiddleware = createMiddleware({
  type: "function",
}).server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error instanceof GatewayError || error instanceof PublicError) {
      throw error;
    }

    if (getGatewayErrorCode(error) || getPublicErrorCode(error)) {
      throw error;
    }

    if (error instanceof ZodError) {
      throw new PublicError("INVALID_INPUT", "Invalid request input");
    }

    // Name, message and stack only: a thrown object (Better Auth's APIError,
    // a failed fetch) can carry response headers or a body.
    logEvent(
      "server_fn.unhandled_error",
      {
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      "error",
    );
    throw new PublicError("INTERNAL_ERROR", "Internal server error");
  }
});
