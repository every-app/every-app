/**
 * `nodeServerHandler()` — serve a Node HTTP framework (Express, NestJS, or
 * anything on `node:http`) from an Every App Worker, through workerd's
 * `cloudflare:node` bridge:
 *
 *   export default everyApp(
 *     nodeServerHandler({
 *       boot: async () => {
 *         const app = await NestFactory.create(AppModule);
 *         await app.listen(0);
 *         return { port: app.getHttpServer().address().port };
 *       },
 *     }),
 *   );
 *
 * `everyApp()` verifies the identity before the Node app sees the request,
 * which still carries it as `x-everyapp-identity`. The bridge needs
 * `nodejs_compat` and a compatibility date from 2025-09-01, which every
 * `everyAppWorker()` has. See "Node frameworks" in the README for the rules
 * such a Worker must follow (minify it, no work at module scope).
 */
import type { EveryAppHandler } from "./everyApp.js";

/** A booted Node server: the port its `http.Server` listens on. */
export interface NodeServer {
  port: number;
}

export interface NodeServerHandlerOptions<TEnv> {
  /**
   * Start the server and return the port it listens on, e.g. `await
   * app.listen(0)` and then `app.getHttpServer().address().port`. Port 0
   * lets workerd pick one; a fixed port is still held by the server of the
   * module graph a Vite reload replaced, in the same isolate. Runs once per
   * isolate, on its first request rather than at module scope; requests
   * that arrive meanwhile wait for it, and a failed boot is retried on the
   * next request.
   */
  boot(env: TEnv): Promise<NodeServer>;
}

/** Statuses whose responses can't carry a body. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * A handler for `everyApp()` that hands each request to the Node server
 * `boot` started. On the way back it drops `Set-Cookie` (the gateway owns
 * the session, and strips cookies from what reaches the app), and passes a
 * body Node already encoded (`content-encoding`, e.g. from `compression()`)
 * through as is: the bridge would let workerd encode it again, and clients
 * would get unreadable bytes.
 */
export function nodeServerHandler<TEnv = Record<string, unknown>>(
  options: NodeServerHandlerOptions<TEnv>,
): EveryAppHandler<TEnv> {
  let booting: Promise<BootedServer> | undefined;
  const server = (env: TEnv): Promise<BootedServer> => {
    if (!booting) {
      const attempt = boot(options, env);
      booting = attempt;
      attempt.catch(() => {
        if (booting === attempt) booting = undefined;
      });
    }
    return booting;
  };

  return async (request, env) => {
    const { port, handleAsNodeRequest } = await server(env);
    return fromNode(await handleAsNodeRequest(port, request));
  };
}

interface BootedServer extends NodeServer {
  handleAsNodeRequest(port: number, request: Request): Promise<Response>;
}

async function boot<TEnv>(
  options: NodeServerHandlerOptions<TEnv>,
  env: TEnv,
): Promise<BootedServer> {
  // Imported here rather than at the top, so that loading the SDK needs no
  // bridge (Node test runners, Workers on an older compatibility date).
  const { handleAsNodeRequest } = await import("cloudflare:node");
  const { port } = await options.boot(env);
  return { port, handleAsNodeRequest };
}

function fromNode(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  return new Response(
    NULL_BODY_STATUSES.has(response.status) ? null : response.body,
    {
      status: response.status,
      statusText: response.statusText,
      headers,
      ...(headers.has("content-encoding") ? { encodeBody: "manual" } : {}),
    },
  );
}
