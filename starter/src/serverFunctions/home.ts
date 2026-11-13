import { createServerFn } from "@tanstack/react-start";
import { GatewayRefusalError, listMembers } from "@every-app/sdk/server";
import { ensureUserMiddleware } from "@every-app/sdk/tanstack-start";
import { env } from "cloudflare:workers";
import { tools } from "@/tools";

/** The first screen's facts: who the Gateway signed in, who can open the app, and its tools. */
export const getHome = createServerFn()
  .middleware([ensureUserMiddleware])
  .handler(async ({ context: { user } }) => {
    return {
      // Never the whole identity: pick what the page shows.
      user: { email: user.email, orgId: user.orgId, orgRole: user.orgRole },
      // The Worker holds no copy of everyapp.config.ts (the Gateway keeps
      // it), only its id: `everyapp create` names the app after it, so the
      // page does too. Write the app's own name here once it has one.
      name: nameFromId(env.EVERYAPP_APP_ID),
      // What an AI assistant may do here (src/tools.ts).
      tools: tools.names,
      members: await whoCanOpen(),
    };
  });

/** `simple-todo` as "Simple Todo": each dash-separated word capitalized. */
function nameFromId(id: string): string {
  return id
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

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
