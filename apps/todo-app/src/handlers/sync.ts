import type { EveryAppUser } from "@every-app/sdk/server";

const SYNC_DO_WEBSOCKET_URL = "http://durable-object/websocket";

/**
 * WebSocket sync endpoint. Identity was already verified fail-closed by
 * everyApp() in the worker entry — the gateway injects x-everyapp-identity on
 * the upgrade request like any other. No token in the URL, no client auth.
 */
export async function handleSyncWebSocket(
  request: Request,
  env: Env,
  user: EveryAppUser | null,
): Promise<Response> {
  const upgradeHeader = request.headers.get("Upgrade");
  if ((upgradeHeader ?? "").toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket upgrade", { status: 426 });
  }

  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Route to the user's Durable Object
  const id = env.USER_SYNC.idFromName(user.id);
  const stub = env.USER_SYNC.get(id);

  return stub.fetch(
    new Request(SYNC_DO_WEBSOCKET_URL, {
      headers: request.headers,
    }),
  );
}
