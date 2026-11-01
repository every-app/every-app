import { createServerFn } from "@tanstack/react-start";
import {
  GatewayRefusalError,
  gatewayUrl,
  listMembers,
} from "@every-app/sdk/server";
import type { EveryAppManifest } from "@every-app/sdk";
import { ensureUserMiddleware } from "@every-app/sdk/tanstack-start";
import { env } from "cloudflare:workers";
import { tools } from "@/tools";

/** The first screen's facts: who the Gateway signed in, and what it allowed this app. */
export const getHome = createServerFn()
  .middleware([ensureUserMiddleware])
  .handler(async ({ context: { user } }) => {
    // everyapp.config.ts, as everyAppWorker() hands it to the Worker. Read
    // through the SDK's manifest type: the first screen lists every kind.
    const manifest: EveryAppManifest = env.EVERYAPP_MANIFEST;
    return {
      // Never the whole identity: pick what the page shows.
      user: { email: user.email, orgId: user.orgId, orgRole: user.orgRole },
      name: manifest.name ?? manifest.id,
      allowed: {
        resources: Object.entries(manifest.resources ?? {}).flatMap(
          ([kind, list]) =>
            list.map(
              (entry: string | { readonly name: string }) =>
                `${kind} ${typeof entry === "string" ? entry : entry.name}`,
            ),
        ),
        public: (manifest.public ?? []).map((route) => route.path),
        providers: (manifest.providers ?? []).map((p) =>
          typeof p === "string" ? p : p.id,
        ),
        capabilities: Object.entries(manifest.capabilities ?? {}).map(
          ([id, { access }]) => `${id} (${access})`,
        ),
        secrets: (manifest.secrets ?? []).map((s) =>
          typeof s === "string" ? s : s.name,
        ),
        tools: tools.names,
      },
      members: await whoCanOpen(),
      // The way back: the Gateway, or `everyapp dev`'s launcher.
      launcher: gatewayUrl(env),
    };
  });

// A capability call. The Gateway answers because everyapp.config.ts lists
// `members`; a refusal is a state the page shows, never a crash. Only the
// count leaves the server: the page shows no more. No `for`: the call is
// the request's, which everyApp() keeps in the request context.
async function whoCanOpen(): Promise<number | { refused: string }> {
  try {
    const { members } = await listMembers({ env });
    return members.length;
  } catch (error) {
    if (error instanceof GatewayRefusalError) return { refused: error.code };
    throw error;
  }
}
