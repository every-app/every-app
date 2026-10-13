import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import {
  APP_BINDING_PREFIX,
  appBindingsDigest,
} from "@every-app/perimeter/manifest";
import { requireDeployTokenAuth } from "@/server/deploy-token-auth";

function respond(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

function gatewayHost(): string | null {
  try {
    return env.GATEWAY_URL ? new URL(env.GATEWAY_URL).host : null;
  } catch {
    return null;
  }
}

/**
 * What this gateway version actually runs, read from its own bindings: the
 * release, the Worker version, and a digest of its app service bindings.
 * `everyapp gateway deploy|reconcile` polls it to see a deploy go live. The
 * public answer reveals no app inventory; with a deploy token it also lists
 * the bound app Workers.
 */
export const Route = createFileRoute("/api/deploy/status")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const bindings = Object.keys(env)
          .filter((name) => name.startsWith(APP_BINDING_PREFIX))
          .sort();
        const status = {
          release: env.EVERYAPP_RELEASE ?? null,
          versionId: env.CF_VERSION_METADATA?.id ?? null,
          appBindingsDigest: await appBindingsDigest(bindings),
        };
        if (!request.headers.has("authorization")) return respond(status);

        const auth = await requireDeployTokenAuth(request);
        if (!auth.ok) return auth.response;
        return respond({
          ...status,
          gatewayHost: gatewayHost(),
          appBindings: bindings.map((name) =>
            name.slice(APP_BINDING_PREFIX.length),
          ),
        });
      },
    },
  },
});
