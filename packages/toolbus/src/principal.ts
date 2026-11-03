/**
 * Who is calling, from the session the perimeter authenticated. Shaped like
 * the perimeter's `AuthenticatedSession` without depending on it.
 *
 * Access follows the credential:
 *  - a browser session acts as the user: read & write;
 *  - a personal access token (`epat_`) is full (`*`): read & write; or read
 *    only (`mcp:read`); anything else has no MCP access.
 */
import { MCP_READ_SCOPE } from "@every-app/sdk/internal";
import type { McpPrincipal } from "./types";

export interface SessionLike {
  sub: string;
  email: string;
  orgId: string;
  orgRole: string;
  orgName?: string;
  credential?: { kind: string; actor?: string; scopes?: string[] };
}

export type PrincipalResolution =
  | { ok: true; principal: McpPrincipal }
  | { ok: false; reason: "token_scope" | "unsupported_credential" };

export function principalFromSession(
  session: SessionLike,
  options: { sessionKind: "session" | "dev" },
): PrincipalResolution {
  const base = {
    userId: session.sub,
    email: session.email,
    organizationId: session.orgId,
    ...(session.orgName ? { organizationName: session.orgName } : {}),
    orgRole: session.orgRole,
  };
  const credential = session.credential;
  if (!credential) {
    return {
      ok: true,
      principal: {
        ...base,
        credential: { kind: options.sessionKind, id: "session" },
        access: "write",
      },
    };
  }
  if (credential.kind !== "pat") {
    return { ok: false, reason: "unsupported_credential" };
  }

  const scopes = credential.scopes ?? [];
  const access = scopes.includes("*")
    ? "write"
    : scopes.includes(MCP_READ_SCOPE)
      ? "read"
      : null;
  if (!access) return { ok: false, reason: "token_scope" };
  const id = credential.actor?.startsWith("pat:")
    ? credential.actor.slice("pat:".length)
    : "pat";
  return {
    ok: true,
    principal: { ...base, credential: { kind: "pat", id }, access },
  };
}
