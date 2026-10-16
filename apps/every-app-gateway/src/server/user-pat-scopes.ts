/**
 * The scope of a deploy key: a personal access token for the hosted deploy
 * API (server/deploy/) and nothing else. It carries no other scope, and
 * the perimeter and the gateway's /mcp refuse it.
 */
export const DEPLOY_SCOPE = "deploy";
