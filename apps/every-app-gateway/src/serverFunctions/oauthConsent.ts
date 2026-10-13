import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { auth } from "@/auth";
import { publicErrorMiddleware } from "@/middleware/publicError";
import { PublicError } from "@/server/errors";
import { getMcpAuth } from "@/server/mcp-auth/config";
import { buildConsentContext } from "@/server/mcp-auth/consent";
import { isMcpOauthEnabled } from "@/server/oauth-flag";
import { isUserBanned } from "@/server/user-ban";

const consentContextSchema = z.object({
  // The consent page's own query: the client's authorization request
  // parameters plus the consent handle.
  query: z.string().max(16 * 1024),
});

/**
 * What the consent page shows: the client as the library describes it from
 * the authorization request in the page's query (never from this
 * function's URL), and the organizations and apps the user can grant. POST,
 * like every server function that reads a session for a decision.
 */
export const getConsentContext = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware])
  .validator((data: unknown) => consentContextSchema.parse(data))
  .handler(async ({ data }) => {
    const mcpAuth = isMcpOauthEnabled(env) ? getMcpAuth(env) : null;
    if (!mcpAuth) {
      throw new PublicError("OAUTH_DISABLED", "OAuth is not enabled");
    }
    const session = await auth.api.getSession({
      headers: getRequest().headers,
    });
    if (!session?.user?.id || isUserBanned(session.user)) {
      return { ok: false as const, signedOut: true as const };
    }
    return buildConsentContext(mcpAuth, env, data.query, {
      id: session.user.id,
      email: session.user.email,
      activeOrganizationId: session.session.activeOrganizationId ?? null,
    });
  });
