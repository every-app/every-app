import { z } from "zod";
import {
  REMOTE_MCP_AUTH_KINDS,
  REMOTE_MCP_RISK_DEFAULTS,
  TOOL_RISKS,
} from "@every-app/sdk/internal";

/**
 * The MCP app server functions' inputs (serverFunctions/mcpApps.ts). These
 * check the shape only: the registry rules (@every-app/perimeter/registry
 * remoteMcpApps.ts) decide what a URL, an id, a credential's name or a
 * header may be, and their refusal carries the sentence the form shows.
 */

/** Empty after trimming reads as not given. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value ? value : undefined))
    .optional();

const rowId = z.string().uuid("Invalid app ID");

const toolOverrideSchema = z
  .object({
    risk: z.enum(TOOL_RISKS).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

/** Adding a remote MCP server by URL (Admin → Apps → Add app). */
export const addRemoteMcpAppSchema = z.object({
  url: z.string().trim().min(1, "Give the server's URL").max(2048),
  /** The app id (the CLI's `--name`); derived from the URL's host when absent. */
  id: optionalText(64),
  /** The name people read; the id when absent. */
  name: optionalText(255),
  description: optionalText(1000),
  auth: z.object({
    kind: z.enum(REMOTE_MCP_AUTH_KINDS),
    /** The Gateway setting's NAME, never a value. */
    secret: optionalText(64),
    header: optionalText(100),
    prefix: z.string().max(32).optional(),
  }),
  risk: z.enum(REMOTE_MCP_RISK_DEFAULTS).optional(),
});

export type AddRemoteMcpAppInput = z.infer<typeof addRemoteMcpAppSchema>;

/** Changing a remote MCP app in place: its risk default, overrides, name or description. */
export const updateRemoteMcpAppSchema = z.object({
  id: rowId,
  risk: z.enum(REMOTE_MCP_RISK_DEFAULTS).optional(),
  /** The whole override map, keyed by the server's tool names. */
  tools: z
    .record(z.string().min(1).max(256), toolOverrideSchema)
    .refine((tools) => Object.keys(tools).length <= 500, {
      message: "At most 500 tool overrides",
    })
    .optional(),
  /** One tool's override merged in; `null` clears it. */
  tool: z
    .object({
      name: z.string().min(1).max(256),
      override: toolOverrideSchema.nullable(),
    })
    .optional(),
  name: z.string().trim().min(1, "Name is required").max(255).optional(),
  description: z.string().trim().max(1000).optional(),
});

export type UpdateRemoteMcpAppInput = z.infer<typeof updateRemoteMcpAppSchema>;

/** Turning an MCP app of either kind on (`active`) or off (`disabled`). */
export const setMcpAppStatusSchema = z.object({
  id: rowId,
  status: z.enum(["active", "disabled"]),
});

/** One MCP app by its row's id: show, refresh, remove. */
export const mcpAppIdSchema = z.object({ id: rowId });
