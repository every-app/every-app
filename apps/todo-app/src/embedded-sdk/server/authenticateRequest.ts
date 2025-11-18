import { getRequest } from "@tanstack/react-start/server";
import {
  createLocalJWKSet,
  jwtVerify,
  JWTVerifyOptions,
  JSONWebKeySet,
} from "jose";

import type { AuthConfig } from "@/embedded-sdk/server";
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
): Promise<SessionTokenPayload | null> {
  const request = getRequest();
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
    // TODO Is there a way to handle this more gracefully?
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "Error verifying session token",
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        errorType: error instanceof Error ? error.constructor.name : "Unknown",
        authConfig,
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

  // TODO Maybe we don't even need this if we just store the jwks as an env when we deploy
  // But, the limitation of these services not being able to talk to each other will be frustrating.
  // I wonder if there is a better abstraction to wrap this dynamic fetching and link all the services together.
  const jwksResponse = import.meta.env.PROD
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
  };

  const { payload } = await jwtVerify(token, localJWKS, options);
  return payload as SessionTokenPayload;
}

function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  return authHeader.substring(7);
}
