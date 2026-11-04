/**
 * The Gateway's OAuth client metadata documents (CIMD,
 * docs/design/2026-11-mcp-apps-auth.md): `GET /oauth-clients/<appId>-mcp`.
 * A remote MCP server whose authorization server registers no clients but
 * takes a document's URL as the client id (ElevenLabs') is given this
 * URL; that authorization server fetches the document from its own
 * servers, so the path is public and bypassed behind Cloudflare Access
 * (`GATEWAY_BYPASS_PATHS`).
 *
 * The document is a public client whose one redirect URI is the Gateway's
 * callback for that app's row, so a code it is issued can only come back
 * to the Gateway, where the connect's state and PKCE verifier are checked
 * as for any provider. It names no secret and nothing about the
 * organization, and it is the same for every well-formed id: served
 * without reading the database, so the path says nothing about which apps
 * the Gateway has, and a stranger's requests cost no D1 read. A client id
 * for an app that doesn't exist only ever sends a code to a callback that
 * has no state for it.
 */
import { env } from "cloudflare:workers";
import {
  REMOTE_MCP_CLIENT_METADATA_PREFIX,
  mcpClientMetadataDocument,
  remoteMcpClientMetadataUrl,
  remoteMcpRedirectUri,
} from "@every-app/sdk/internal";

const ROW_ID = /^[a-z][a-z0-9-]{0,31}-mcp$/;

function notFound(): Response {
  return Response.json(
    { error: "not_found" },
    { status: 404, headers: { "cache-control": "no-store" } },
  );
}

/** The document for `pathname`, a 404, or null when the path isn't one of these. */
export function serveClientMetadata(request: Request): Response | null {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith(REMOTE_MCP_CLIENT_METADATA_PREFIX)) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return Response.json(
      { error: "method_not_allowed" },
      {
        status: 405,
        headers: { allow: "GET, HEAD", "cache-control": "no-store" },
      },
    );
  }
  const rowId = pathname.slice(REMOTE_MCP_CLIENT_METADATA_PREFIX.length);
  if (!ROW_ID.test(rowId)) return notFound();
  const appId = rowId.slice(0, -"-mcp".length);
  const gatewayUrl = String(
    (env as unknown as { GATEWAY_URL?: string }).GATEWAY_URL ?? "",
  );
  const clientId = remoteMcpClientMetadataUrl(gatewayUrl, appId);
  if (!clientId) return notFound();
  const origin = new URL(clientId).origin;
  const document = mcpClientMetadataDocument({
    clientId,
    redirectUri: remoteMcpRedirectUri(gatewayUrl, appId),
    clientName: `Every App (${new URL(origin).host})`,
    clientUri: origin,
  });
  return Response.json(document, {
    headers: { "cache-control": "public, max-age=300" },
  });
}
