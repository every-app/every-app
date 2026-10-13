/**
 * The OAuth authorization server for MCP clients is off unless the operator
 * sets the MCP_OAUTH_ENABLED secret to "true". The tokens it issues are bound
 * to an app resource the perimeter cannot validate yet (every one is rejected),
 * while its open client registration and consent page sit on the public
 * gateway. So while it is off, its endpoints and discovery documents 404, app
 * hosts stop advertising it, and personal access tokens are the only bearer
 * credential.
 */
export function isMcpOauthEnabled(runtimeEnv: {
  MCP_OAUTH_ENABLED?: string;
}): boolean {
  return runtimeEnv.MCP_OAUTH_ENABLED?.trim().toLowerCase() === "true";
}

const OAUTH_PATH =
  /^\/(?:oauth(?:\/|$)|\.well-known\/(?:oauth-authorization-server|oauth-protected-resource|openid-configuration)(?:\/|$))/;

/** Gateway-host paths owned by the OAuth server and its discovery documents. */
export function isOauthPath(pathname: string): boolean {
  return OAUTH_PATH.test(pathname);
}
