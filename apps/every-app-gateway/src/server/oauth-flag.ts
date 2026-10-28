/**
 * The OAuth authorization server for MCP clients (claude.ai, ChatGPT, Claude
 * Code, Cursor) is on unless the operator sets the MCP_OAUTH_ENABLED secret
 * to "false" (or "0", "off", "no"): the kill switch from before it was
 * rebuilt. While it is off, `/oauth/*` and the OAuth discovery documents
 * 404, and the gateway's `/mcp` accepts personal access tokens only, with a
 * 401 that names no authorization server. See docs/runbooks/mcp-oauth.md.
 *
 * Dynamic client registration (/oauth/register) is on with it unless
 * MCP_DCR_ENABLED is "false": Cursor, Gemini CLI and MCP Inspector can only
 * register that way. Off, only clients with a Client ID Metadata Document
 * connect (claude.ai, Claude Desktop and mobile, Claude Code, ChatGPT,
 * VS Code, Codex), and clients registered before keep working.
 *
 * A value that is neither on nor off ("disabled", say) turns a switch off
 * too, with a warning: someone set it, and a kill switch fails closed.
 */
import { logEvent } from "@every-app/perimeter";

const ON_VALUES = new Set(["true", "1", "on", "yes"]);
const OFF_VALUES = new Set(["false", "0", "off", "no"]);
const warned = new Set<string>();

/** Whether a switch that is on by default is on. */
function switchedOn(name: string, setting: string | undefined): boolean {
  const value = setting?.trim().toLowerCase();
  if (!value || ON_VALUES.has(value)) return true;
  if (!OFF_VALUES.has(value) && !warned.has(`${name}=${value}`)) {
    warned.add(`${name}=${value}`);
    logEvent(
      "mcp.oauth.flag_unrecognized",
      {
        name,
        value: value.slice(0, 32),
        reason: `${name} is neither on nor off, so it is off. Use "false", or delete it.`,
      },
      "warn",
    );
  }
  return false;
}

export function isMcpOauthEnabled(runtimeEnv: {
  MCP_OAUTH_ENABLED?: string;
}): boolean {
  return switchedOn("MCP_OAUTH_ENABLED", runtimeEnv.MCP_OAUTH_ENABLED);
}

/** Whether OAuth clients may register dynamically (with OAuth on). */
export function isMcpDcrEnabled(runtimeEnv: {
  MCP_DCR_ENABLED?: string;
}): boolean {
  return switchedOn("MCP_DCR_ENABLED", runtimeEnv.MCP_DCR_ENABLED);
}

/**
 * GATEWAY_URL's origin as the OAuth issuer, or null when it can't be one:
 * OAuth needs https, or http on exactly `localhost` / `127.0.0.1` (not
 * `*.localhost`) for local testing. The same rule `mcp-auth/config.ts`
 * builds the server with, kept here (a leaf module) so the perimeter can
 * name the issuer on app hosts without importing the server's module
 * graph for every request.
 */
export function oauthIssuer(runtimeEnv: {
  GATEWAY_URL?: string;
}): string | null {
  if (!runtimeEnv.GATEWAY_URL) return null;
  let url: URL;
  try {
    url = new URL(runtimeEnv.GATEWAY_URL);
  } catch {
    return null;
  }
  const loopback =
    url.hostname === "localhost" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return null;
  }
  return url.origin;
}

const OAUTH_PATH =
  /^\/(?:oauth(?:\/|$)|\.well-known\/(?:oauth-authorization-server|oauth-protected-resource|openid-configuration)(?:\/|$))/;

/** Gateway-host paths owned by the OAuth server and its discovery documents. */
export function isOauthPath(pathname: string): boolean {
  return OAUTH_PATH.test(pathname);
}
