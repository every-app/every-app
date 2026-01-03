import { z } from "zod";

// ============================================================================
// Message Schemas for postMessage Communication
// ============================================================================

export const SessionTokenRequestSchema = z.object({
  type: z.literal("SESSION_TOKEN_REQUEST"),
  requestId: z.string(),
  appId: z.string().optional(),
});

export const RouteChangeMessageSchema = z.object({
  type: z.literal("ROUTE_CHANGE"),
  route: z.string(),
  direction: z.enum(["parent-to-child", "child-to-parent"]),
  appId: z.string().optional(),
});

const SessionTokenResponseMessageSchema = z.object({
  type: z.literal("SESSION_TOKEN_RESPONSE"),
  requestId: z.string(),
  token: z.string().optional(),
  expiresAt: z.string().optional(),
  audience: z.string().optional(),
  appId: z.string().optional(),
  error: z.string().optional(),
});

const EmbeddedAppReadyMessageSchema = z.object({
  type: z.literal("EMBEDDED_APP_READY"),
});

// ============================================================================
// Inferred Types
// ============================================================================

export type SessionTokenResponseMessage = z.infer<
  typeof SessionTokenResponseMessageSchema
>;
type EmbeddedAppReadyMessage = z.infer<typeof EmbeddedAppReadyMessageSchema>;

// ============================================================================
// Union Types for Message Handling
// ============================================================================

/**
 * Messages sent from the parent (gateway) to the embedded app iframe.
 */
export type ParentToChildMessage = RouteChangeMessage | EmbeddedAppReadyMessage;

/**
 * All possible iframe message types (for postMessage handlers).
 */
export type IframeMessage = ParentToChildMessage | SessionTokenResponseMessage;

// Re-export inferred types that are used externally
type RouteChangeMessage = z.infer<typeof RouteChangeMessageSchema>;
