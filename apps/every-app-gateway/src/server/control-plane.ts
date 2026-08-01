import handler from "@tanstack/react-start/server-entry";

type AssetsBinding = { fetch(request: Request): Promise<Response> };

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
  return handler.fetch(request);
}
