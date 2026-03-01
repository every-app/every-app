import { createMiddleware } from "@tanstack/react-start";
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

    console.error("Unhandled server function error", error);
    throw new PublicError("INTERNAL_ERROR", "Internal server error");
  }
});
