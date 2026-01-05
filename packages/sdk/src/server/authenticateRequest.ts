import { getRequest } from "@tanstack/react-start/server";
import {
  createLocalJWKSet,
  jwtVerify,
  JWTVerifyOptions,
  JSONWebKeySet,
} from "jose";

import type { AuthConfig } from "./types";
import { env } from "cloudflare:workers";

interface SessionTokenPayload {
  sub: string;
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  appId?: string;
  permissions?: string[];
  email?: string;
}

export async function authenticateRequest(
  authConfig: AuthConfig,
  providedRequest?: Request,
): Promise<SessionTokenPayload | null> {
  const request = providedRequest || getRequest();
  const authHeader = request.headers.get("authorization");

  if (!authHeader) {
    console.log("No auth header found");
    return null;
  }

  const token = extractBearerToken(authHeader);

  if (!token) {
    return null;
  }

  try {
    const session = await verifySessionToken(token, authConfig);
    return session;
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "Error verifying session token",
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        errorType: error instanceof Error ? error.constructor.name : "Unknown",
        issuer: authConfig.issuer,
        audience: authConfig.audience,
      }),
    );
    return null;
  }
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
