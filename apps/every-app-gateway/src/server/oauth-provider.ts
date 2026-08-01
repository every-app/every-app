import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { serveControlPlane } from "./control-plane";

let provider: OAuthProvider<Cloudflare.Env> | null = null;

export function getOauthProvider(): OAuthProvider<Cloudflare.Env> {
  provider ??= new OAuthProvider<Cloudflare.Env>({
    apiRoute: "/oauth/userinfo",
    apiHandler: {
      fetch: (_request, _env, ctx) =>
        Response.json(
          (ctx as ExecutionContext & { props?: unknown }).props ?? {},
        ),
    },
    defaultHandler: {
      fetch: (request, env) => serveControlPlane(request, env),
    },
    authorizeEndpoint: "/oauth/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    allowImplicitFlow: false,
    allowPlainPKCE: false,
  });
  return provider;
}

/**
 * TanStack's server entry never exposes the worker ExecutionContext, so
 * provider calls get a no-op one. Background work the provider schedules via
 * waitUntil (KV cleanup) is dropped; expiry TTLs still bound the state.
 */
export function syntheticExecutionContext(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
}
