/**
 * What a personal access token may do, and the scopes it is stored with:
 *
 *  - `read`: MCP tools that read (`mcp:read`); no app route;
 *  - `full`: acts as you on every app route and every MCP tool (`*`);
 *  - `deploy`: a deploy key, for the hosted deploy API (server/deploy/) and
 *    nothing else; the perimeter and the gateway's /mcp refuse it. Offered
 *    only where the gateway takes third-party deploys.
 *
 * Any token may also be limited to one app.
 */
export const DEPLOY_SCOPE = "deploy";

export const TOKEN_ACCESS = ["read", "full", "deploy"] as const;
export type TokenAccess = (typeof TOKEN_ACCESS)[number];

export const TOKEN_ACCESS_SCOPES: Record<TokenAccess, string[]> = {
  read: ["mcp:read"],
  full: ["*"],
  deploy: [DEPLOY_SCOPE],
};

/** A stored token's access, or null for scopes no token is made with now. */
export function tokenAccessOf(scopes: readonly string[]): TokenAccess | null {
  if (scopes.length !== 1) return null;
  const [scope] = scopes;
  return (
    TOKEN_ACCESS.find((access) => TOKEN_ACCESS_SCOPES[access][0] === scope) ??
    null
  );
}

/** How long a new token lasts, in days. */
export const TOKEN_EXPIRY_DAYS = [7, 30, 90, 365] as const;
export type TokenExpiryDays = (typeof TOKEN_EXPIRY_DAYS)[number];
