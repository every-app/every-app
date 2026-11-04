import { z } from "zod";
import {
  REMOTE_MCP_CREDENTIAL_KINDS,
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

/** Adding a remote MCP server by URL (Admin → Apps → Add MCP server). */
export const addRemoteMcpAppSchema = z.object({
  url: z.string().trim().min(1, "Give the server's URL").max(2048),
  /** The app id (the CLI's `--name`); derived from the URL's host when absent. */
  id: optionalText(64),
  /** The name people read; the id when absent. */
  name: optionalText(255),
  description: optionalText(1000),
  /**
   * The credential: none; a static kind (`bearer`, `header`, `query`,
   * `basic`), which becomes the app's own API-key provider row whose
   * value the operator sets in a terminal (never here); `oauth`, a
   * discovered row and a client registered with the server (or pasted:
   * `clientId`, `clientSecret`, the Admin form's sealed paste, never a
   * tool's); or `provider`, an existing provider of the registry.
   */
  auth: z
    .object({
      kind: z.enum([...REMOTE_MCP_CREDENTIAL_KINDS, "provider"]),
      /** `header`: the header's name. */
      header: optionalText(100),
      /** `bearer`: another scheme; `header`: text before the value. */
      prefix: z.string().max(32).optional(),
      /** `query`: the parameter's name. */
      param: optionalText(100),
      /** `provider`: its id. */
      provider: optionalText(40),
      /** `oauth`, when the server can't register a client: the pasted client id. */
      clientId: optionalText(512),
      /** And its secret, sealed on the Gateway (a public client has none). */
      clientSecret: optionalText(2048),
    })
    // A field it doesn't know (a value where a name went) is refused, not dropped.
    .strict(),
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

/** An MCP app by its app id (`treg`), for a member's connection status. */
export const mcpAppConnectionSchema = z.object({
  appId: z.string().trim().min(1).max(64),
});
