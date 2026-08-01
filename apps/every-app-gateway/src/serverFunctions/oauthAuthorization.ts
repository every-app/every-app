import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { auth } from "@/auth";
import {
  buildAccessDeniedRedirect,
  resolveAuthorizeRequest,
} from "@/server/oauth-consent";
import { z } from "zod";

const authorizeActionSchema = z.object({
  query: z.string(),
});

function authorizeRequestFromQuery(query: string): Request {
  const request = getRequest();
  const url = new URL("/oauth/authorize", request.url);
  url.search = query.startsWith("?") ? query : `?${query}`;
  return new Request(url, { headers: request.headers });
}

async function requireSession() {
  const request = getRequest();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user?.id) {
    return null;
  }
  return session;
}

export const getAuthorizeContext = createServerFn().handler(async () => {
  const session = await requireSession();
  if (!session?.user?.id) {
    return {
      ok: false as const,
      unauthenticated: true,
      message: "Sign in to continue",
    };
  }

  const request = getRequest();
  const oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const clientInfo = await env.OAUTH_PROVIDER.lookupClient(
    oauthRequest.clientId,
  );

  return resolveAuthorizeRequest({
    request: oauthRequest,
    clientInfo,
    userId: session.user.id,
    userEmail: session.user.email,
  }).then((resolved) => {
    if (!resolved.ok) return resolved;
    return {
      ok: true as const,
      client: resolved.client,
      app: resolved.app,
      user: resolved.user,
      scopes: resolved.scopes,
      fullAccess: resolved.fullAccess,
    };
  });
});

export const approveAuthorization = createServerFn()
  .inputValidator((data: unknown) => authorizeActionSchema.parse(data))
  .handler(async ({ data }) => {
    const session = await requireSession();
    if (!session?.user?.id) {
      throw new Error("Unauthorized");
    }

    const request = authorizeRequestFromQuery(data.query);
    const oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    const clientInfo = await env.OAUTH_PROVIDER.lookupClient(
      oauthRequest.clientId,
    );
    const resolved = await resolveAuthorizeRequest({
      request: oauthRequest,
      clientInfo,
      userId: session.user.id,
      userEmail: session.user.email,
    });
    if (!resolved.ok) {
      throw new Error(resolved.message);
    }

    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: resolved.request,
      userId: session.user.id,
      scope: resolved.scopes,
      props: {
        userId: session.user.id,
        organizationId: resolved.app.organizationId,
        appRowId: resolved.app.rowId,
        appSlug: resolved.app.appId,
        scopes: resolved.scopes,
        clientId: resolved.client.clientId,
        grantedAt: new Date().toISOString(),
      },
      metadata: {
        clientName: resolved.client.name,
        appName: resolved.app.name,
        appSlug: resolved.app.appId,
      },
    });
    return { redirectTo };
  });

export const denyAuthorization = createServerFn()
  .inputValidator((data: unknown) => authorizeActionSchema.parse(data))
  .handler(async ({ data }) => {
    const request = authorizeRequestFromQuery(data.query);
    const oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    return { redirectTo: buildAccessDeniedRedirect(oauthRequest) };
  });
