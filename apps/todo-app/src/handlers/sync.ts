import {
  authenticateRequest,
  getAuthConfig,
} from "@every-app/sdk/tanstack/server";

const SYNC_DO_WEBSOCKET_URL = "http://durable-object/websocket";

/**
 * Validates WebSocket upgrade header.
 * Returns error response if invalid, null if valid.
 */
function validateWebSocketUpgrade(request: Request): Response | null {
  const upgradeHeader = request.headers.get("Upgrade");
  if (upgradeHeader !== "websocket") {
    return new Response("Expected WebSocket upgrade", { status: 426 });
  }
  return null;
}

/**
 * Extracts token from request query parameters.
 * Returns null if no token is present.
 */
function extractTokenFromRequest(request: Request): string | null {
  const url = new URL(request.url);
  return url.searchParams.get("token");
}

/**
 * Authenticates a WebSocket connection using a bearer token.
 * Returns the session if valid, null otherwise.
 */
async function authenticateWebSocket(token: string) {
  // Create a synthetic request with the token as Authorization header
  // since authenticateRequest expects a request object
  const authRequest = new Request("https://auth-check", {
    headers: new Headers({
      Authorization: `Bearer ${token}`,
    }),
  });

  const authConfig = getAuthConfig();
  return authenticateRequest(authConfig, authRequest);
}

export async function handleSyncWebSocket(
  request: Request,
  env: Env,
): Promise<Response> {
  const upgradeError = validateWebSocketUpgrade(request);
  if (upgradeError) {
    return upgradeError;
  }

  const token = extractTokenFromRequest(request);
  if (!token) {
    return new Response("Unauthorized", { status: 401 });
  }

  const session = await authenticateWebSocket(token);
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Route to the user's Durable Object
  const id = env.USER_SYNC.idFromName(session.sub);
  const stub = env.USER_SYNC.get(id);

  return stub.fetch(
    new Request(SYNC_DO_WEBSOCKET_URL, {
      headers: request.headers,
    }),
  );
}
