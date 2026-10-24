import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { GatewayRefusalError, listMembers } from "@every-app/sdk/server";
import { env } from "cloudflare:workers";
import { ensureUserMiddleware } from "@/middleware/ensureUser";
import { tools } from "@/tools";

// The fields of everyapp.config.ts the first screen lists. The manifest is
// inlined at build time by vite.config.ts: the Worker never imports the file.
interface Manifest {
  name: string;
  resources?: Record<string, readonly (string | { name: string })[]>;
  public?: readonly { path: string }[];
  providers?: readonly (string | { id: string })[];
  capabilities?: Record<string, { access: string }>;
  secrets?: readonly (string | { name: string })[];
}
const manifest: Manifest = __EVERYAPP_MANIFEST__;

/** The first screen's facts: who the Gateway signed in, and what it allowed this app. */
export const getHome = createServerFn()
  .middleware([ensureUserMiddleware])
  .handler(async ({ context: { user } }) => {
    const request = getRequest();
    const url = new URL(request.url);
    return {
      // Never the whole identity: pick what the page shows.
      user: { email: user.email, orgId: user.orgId, orgRole: user.orgRole },
      name: manifest.name,
      allowed: {
        resources: Object.entries(manifest.resources ?? {}).flatMap(
          ([kind, list]) =>
            list.map(
              (entry) =>
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
      members: await whoCanOpen(request),
      // The Gateway's URL is the identity issuer the deploy sets. `everyapp dev`
      // mints with a placeholder issuer, so there it is the host one label up.
      launcher: env.EVERYAPP_DEV
        ? `${url.protocol}//${url.host.slice(url.host.indexOf(".") + 1)}/`
        : env.EVERYAPP_IDENTITY_ISSUER,
    };
  });

// A capability call. The Gateway answers because everyapp.config.ts lists
// `members`; a refusal is a state the page shows, never a crash. Only the
// count leaves the server: the page shows no more.
async function whoCanOpen(
  request: Request,
): Promise<number | { refused: string }> {
  try {
    const { members } = await listMembers({ env, for: request });
    return members.length;
  } catch (error) {
    if (error instanceof GatewayRefusalError) return { refused: error.code };
    throw error;
  }
}
