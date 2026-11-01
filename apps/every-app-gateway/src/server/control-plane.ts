type AssetsBinding = { fetch(request: Request): Promise<Response> };

type ServerEntry = typeof import("@tanstack/react-start/server-entry");

/**
 * The TanStack Start server entry (React DOM server and the route tree's
 * server code) is most of this Worker. It loads with the first control-plane
 * request on an isolate and is kept for the isolate's life; an isolate that
 * only ever serves app hosts never evaluates it.
 */
let serverEntry: Promise<ServerEntry> | undefined;

function loadServerEntry(): Promise<ServerEntry> {
  serverEntry ??= import("@tanstack/react-start/server-entry");
  return serverEntry;
}

export async function serveControlPlane(
  request: Request,
  runtimeEnv: { ASSETS?: AssetsBinding },
): Promise<Response> {
  // With run_worker_first the worker owns asset serving for its own host.
  const assets = runtimeEnv.ASSETS;
  if (assets && (request.method === "GET" || request.method === "HEAD")) {
    const assetResponse = await assets.fetch(request);
    if (assetResponse.status !== 404) return assetResponse;
  }
  const { default: handler } = await loadServerEntry();
  return handler.fetch(request);
}
