import { and, eq } from "drizzle-orm";
import type {
  AuthRequest,
  ClientInfo,
} from "@cloudflare/workers-oauth-provider";
import { env } from "cloudflare:workers";
import { db } from "@/db";
import { members } from "@/db/schema";
import { resolvePrimaryOrganizationRole } from "@/server/org-roles";
import { AppRepository } from "@/server/repositories/AppRepository";
import { DrizzleAppRegistry } from "@/perimeter/drizzleAppRegistry";
import { resolveAppByHostname } from "@/server";

const DEFAULT_SCOPES = ["*"] as const;

type AuthorizeError = {
  ok: false;
  message: string;
};

type AuthorizeContext = {
  ok: true;
  client: {
    clientId: string;
    name: string;
    logoUri?: string;
  };
  app: {
    rowId: string;
    appId: string;
    name: string;
    organizationId: string;
  };
  user: {
    id: string;
    email: string;
  };
  scopes: string[];
  fullAccess: boolean;
};

type ResolvedAuthorizeRequest =
  | AuthorizeError
  | (AuthorizeContext & {
      request: AuthRequest;
      clientInfo: ClientInfo | null;
    });

export function resolveGrantedScopes(
  requestedScopes: string[],
  manifestScopes: Record<string, string> | undefined,
): { ok: true; scopes: string[]; fullAccess: boolean } | AuthorizeError {
  if (
    requestedScopes.some(
      (scope) => scope === "*" || scope.startsWith("provider:"),
    )
  ) {
    return {
      ok: false,
      message: "This authorization request asked for unsupported scopes",
    };
  }

  const declaredScopes = Object.keys(manifestScopes ?? {});
  if (declaredScopes.length === 0 || requestedScopes.length === 0) {
    return { ok: true, scopes: [...DEFAULT_SCOPES], fullAccess: true };
  }

  const declared = new Set(declaredScopes);
  const granted = requestedScopes.filter((scope) => declared.has(scope));
  if (granted.length === 0) {
    return {
      ok: false,
      message: "This authorization request didn't ask for valid app scopes",
    };
  }

  return { ok: true, scopes: granted, fullAccess: false };
}

export function resolveResourceUrl(request: AuthRequest): URL | AuthorizeError {
  const resource = Array.isArray(request.resource)
    ? request.resource[0]
    : request.resource;
  if (!resource) {
    return {
      ok: false,
      message: "This authorization request didn't specify a valid app",
    };
  }
  try {
    const url = new URL(resource);
    if (url.protocol !== "https:") {
      return {
        ok: false,
        message: "This authorization request didn't specify a valid app",
      };
    }
    return url;
  } catch {
    return {
      ok: false,
      message: "This authorization request didn't specify a valid app",
    };
  }
}

export async function resolveAuthorizeRequest(options: {
  request: AuthRequest;
  clientInfo: ClientInfo | null;
  userId: string;
  userEmail: string;
}): Promise<ResolvedAuthorizeRequest> {
  const resourceUrl = resolveResourceUrl(options.request);
  if ("ok" in resourceUrl) return resourceUrl;

  const registry = new DrizzleAppRegistry(env.DB);
  const registeredApp = await resolveAppByHostname(
    registry,
    resourceUrl.hostname.toLowerCase(),
  );
  if (!registeredApp || registeredApp.status !== "active") {
    return {
      ok: false,
      message: "This authorization request didn't specify a valid app",
    };
  }

  const membership = await db.query.members.findFirst({
    where: and(
      eq(members.userId, options.userId),
      eq(members.organizationId, registeredApp.organizationId),
    ),
  });
  if (!membership || !resolvePrimaryOrganizationRole(membership.role)) {
    return {
      ok: false,
      message: "This authorization request didn't specify a valid app",
    };
  }

  const appRow = await AppRepository.findByAppSlug(
    registeredApp.appId,
    registeredApp.organizationId,
  );
  if (!appRow) {
    return {
      ok: false,
      message: "This authorization request didn't specify a valid app",
    };
  }

  const grantedScopes = resolveGrantedScopes(
    options.request.scope,
    registeredApp.manifest.scopes,
  );
  if (!grantedScopes.ok) return grantedScopes;

  return {
    ok: true,
    request: options.request,
    clientInfo: options.clientInfo,
    client: {
      clientId: options.request.clientId,
      name:
        options.clientInfo?.clientName?.trim() ||
        options.clientInfo?.clientUri?.trim() ||
        options.request.clientId,
      logoUri: safeLogoUri(options.clientInfo?.logoUri),
    },
    app: {
      rowId: appRow.id,
      appId: registeredApp.appId,
      name: appRow.name || registeredApp.manifest.name || registeredApp.appId,
      organizationId: registeredApp.organizationId,
    },
    user: {
      id: options.userId,
      email: options.userEmail,
    },
    scopes: grantedScopes.scopes,
    fullAccess: grantedScopes.fullAccess,
  };
}

function safeLogoUri(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function buildAccessDeniedRedirect(request: AuthRequest): string {
  const redirectTo = new URL(request.redirectUri);
  redirectTo.searchParams.set("error", "access_denied");
  if (request.state) {
    redirectTo.searchParams.set("state", request.state);
  }
  return redirectTo.toString();
}
