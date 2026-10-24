import { createMiddleware } from "@tanstack/react-start";
import { logEvent } from "@every-app/perimeter";
import {
  GatewayError,
  PublicError,
  getGatewayErrorCode,
  getPublicErrorCode,
} from "@/server/errors";
import { ZodError } from "zod";

/**
 * What a server-function error carries on the wire: its code, its message
 * and its name (the literal the class sets, "GatewayError" or
 * "PublicError"; without it seroval would send the bundle's class name).
 */
const WIRE_PROPERTIES = new Set(["code", "message", "name"]);

/**
 * A fresh error with only the wire properties as own properties. TanStack
 * serializes a thrown error with seroval, which copies every own property
 * into the response body, `stack` included (its ErrorPrototypeStack
 * feature is on by default), so an error that left here as thrown would
 * put the bundle's paths and frames on the wire, and anything riding on it
 * (a `cause`, headers) would go too. The error the handler threw is left
 * as it was. The browser reads `code` alone (client/errors.ts).
 */
function forWire<T extends Error>(fresh: T): T {
  for (const key of Object.getOwnPropertyNames(fresh)) {
    if (!WIRE_PROPERTIES.has(key)) {
      delete (fresh as unknown as Record<string, unknown>)[key];
    }
  }
  return fresh;
}

function gatewayWireError(
  code: GatewayError["code"],
  message: string,
): GatewayError {
  return forWire(new GatewayError(code, message));
}

function publicWireError(
  code: PublicError["code"],
  message: string,
): PublicError {
  return forWire(new PublicError(code, message));
}

function messageOf(error: unknown, fallback: string): string {
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : fallback;
}

export const publicErrorMiddleware = createMiddleware({
  type: "function",
}).server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    // A GatewayError or PublicError, the class itself or anything else
    // carrying one of their codes (a plain object, an error from another
    // copy of the module): its code and message, nothing else of it.
    const gatewayCode = getGatewayErrorCode(error);
    if (gatewayCode) {
      throw gatewayWireError(gatewayCode, messageOf(error, gatewayCode));
    }
    const publicCode = getPublicErrorCode(error);
    if (publicCode) {
      throw publicWireError(publicCode, messageOf(error, publicCode));
    }

    if (error instanceof ZodError) {
      throw publicWireError("INVALID_INPUT", "Invalid request input");
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
    throw publicWireError("INTERNAL_ERROR", "Internal server error");
  }
});
