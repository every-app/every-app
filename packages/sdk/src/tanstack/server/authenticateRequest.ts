import { getRequest } from "@tanstack/react-start/server";
import {
  createLocalJWKSet,
  jwtVerify,
  JWTVerifyOptions,
  JSONWebKeySet,
} from "jose";

import type { AuthConfig } from "./types.js";
import { env } from "cloudflare:workers";
import {
  BYPASS_GATEWAY_LOCAL_ONLY_TOKEN,
  createBypassGatewayLocalOnlySessionPayload,
  isBypassGatewayLocalOnlyServer,
} from "../../shared/bypassGatewayLocalOnly.js";

/**
 * JWT payload structure for embedded app session tokens.
 * Contains minimal claims for security - only what's needed for authentication.
 */
interface SessionTokenPayload {
  /** User ID (subject claim) */
  sub: string;
  /** Gateway URL (issuer claim) */
  iss: string;
  /** App ID (audience claim) - scopes token to specific app */
  aud: string;
  /** Expiration timestamp */
  exp: number;
  /** Issued at timestamp */
  iat: number;
  /** User email - used for user provisioning in apps */
  email?: string;
  /** Organization ID used for org-bound runtime enforcement */
  orgId?: string;
}

type GatewayRuntimeEnv = {
  BYPASS_GATEWAY_LOCAL_ONLY?: string;
  APP_TENANCY_MODE?: string;
  EVERY_APP_ORG_ID?: string;
};

type AppTenancyMode = "single" | "multi";

type OrgValidationSource = "bypass" | "session";

export async function authenticateRequest(
  authConfig: AuthConfig,
  providedRequest?: Request,
): Promise<SessionTokenPayload | null> {
  const request = providedRequest || getRequest();
  const authHeader = request.headers.get("authorization");
  const expectedOrganizationId = getOptionalEnvValue("EVERY_APP_ORG_ID");
  const appTenancyMode = getAppTenancyMode();

  const isBypassGatewayLocalOnly =
    import.meta.env.PROD !== true &&
    (getOptionalEnvValue("BYPASS_GATEWAY_LOCAL_ONLY") === "true" ||
      isBypassGatewayLocalOnlyServer() === true);

  if (!authHeader) {
    return null;
  }

  const token = extractBearerToken(authHeader);

  if (!token) {
    return null;
  }

  if (isBypassGatewayLocalOnly) {
    if (token !== BYPASS_GATEWAY_LOCAL_ONLY_TOKEN) {
      return null;
    }

    if (!expectedOrganizationId) {
      console.error(
        JSON.stringify({
          message:
            "BYPASS_GATEWAY_LOCAL_ONLY requires EVERY_APP_ORG_ID to be set.",
          audience: authConfig.audience,
          appTenancyMode,
        }),
      );
      return null;
    }

    const session = createBypassGatewayLocalOnlySessionPayload(
      authConfig.audience,
      expectedOrganizationId,
    );

    if (
      !validateOrganizationBinding({
        session,
        source: "bypass",
        audience: authConfig.audience,
        expectedOrganizationId,
        appTenancyMode,
      })
    ) {
      return null;
    }

    return session;
  }

  try {
    const session = await verifySessionToken(token, authConfig);

    if (
      !validateOrganizationBinding({
        session,
        source: "session",
        audience: authConfig.audience,
        expectedOrganizationId,
        appTenancyMode,
      })
    ) {
      return null;
    }

    return session;
  } catch (error) {
    const isProd = import.meta.env.PROD === true;
    console.error(
      JSON.stringify({
        message: "Error verifying session token",
        error: error instanceof Error ? error.message : String(error),
        stack:
          isProd === true
            ? undefined
            : error instanceof Error
              ? error.stack
              : undefined,
        errorType: error instanceof Error ? error.constructor.name : "Unknown",
        issuer: authConfig.issuer,
        audience: authConfig.audience,
        expectedOrganizationId,
        appTenancyMode,
      }),
    );
    return null;
  }
}

function getAppTenancyMode(): AppTenancyMode {
  const mode = getOptionalEnvValue("APP_TENANCY_MODE")?.toLowerCase();
  return mode === "multi" ? "multi" : "single";
}

async function verifySessionToken(
  token: string,
  config: AuthConfig,
): Promise<SessionTokenPayload> {
  const { issuer, audience } = config;

  if (!issuer) {
    throw new Error("Issuer must be provided for token verification");
  }

  if (!audience) {
    throw new Error("Audience must be provided for token verification");
  }

  // Fetch JWKS - use service binding in production, direct fetch in development
  const jwksResponse =
    import.meta.env.PROD && env.EVERY_APP_GATEWAY
      ? await env.EVERY_APP_GATEWAY.fetch("http://localhost/api/embedded/jwks")
      : await fetch(`${env.GATEWAY_URL}/api/embedded/jwks`);

  if (!jwksResponse.ok) {
    throw new Error(
      `Failed to fetch JWKS: ${jwksResponse.status} ${jwksResponse.statusText}`,
    );
  }

  const jwks = (await jwksResponse.json()) as JSONWebKeySet;
  const localJWKS = createLocalJWKSet(jwks);

  const options: JWTVerifyOptions = {
    issuer,
    audience,
    algorithms: ["RS256"],
  };

  const { payload } = await jwtVerify(token, localJWKS, options);
  return payload as SessionTokenPayload;
}

/**
 * Extracts the bearer token from an Authorization header.
 *
 * @param authHeader - The Authorization header value (e.g., "Bearer eyJ...")
 * @returns The token string if valid, null otherwise
 */
export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  return authHeader.substring(7);
}

function getOptionalEnvValue(key: keyof GatewayRuntimeEnv): string | null {
  const value = (env as GatewayRuntimeEnv)[key];
  const trimmed = value?.trim();
  return trimmed || null;
}

function validateOrganizationBinding({
  session,
  source,
  audience,
  expectedOrganizationId,
  appTenancyMode,
}: {
  session: SessionTokenPayload;
  source: OrgValidationSource;
  audience: string;
  expectedOrganizationId: string | null;
  appTenancyMode: AppTenancyMode;
}): boolean {
  if (!session.orgId) {
    console.error(
      JSON.stringify({
        message:
          source === "bypass"
            ? "Bypass mode requires organization claim"
            : "Session token is missing orgId. SDK v0.2.0 requires org-bound session tokens. Redeploy the app with EVERY_APP_ORG_ID configured and request a fresh session token.",
        audience,
        appTenancyMode,
      }),
    );
    return false;
  }

  if (appTenancyMode === "single" && !expectedOrganizationId) {
    console.error(
      JSON.stringify({
        message:
          "EVERY_APP_ORG_ID is required when APP_TENANCY_MODE=single. Configure EVERY_APP_ORG_ID in worker secrets (for example via `every app deploy`) and retry.",
        audience,
        appTenancyMode,
      }),
    );
    return false;
  }

  if (appTenancyMode === "single" && session.orgId !== expectedOrganizationId) {
    console.error(
      JSON.stringify({
        message:
          source === "bypass"
            ? "Bypass mode organization mismatch"
            : "Session token organization mismatch",
        tokenOrgId: session.orgId,
        expectedOrganizationId,
        audience,
        appTenancyMode,
      }),
    );
    return false;
  }

  return true;
}
