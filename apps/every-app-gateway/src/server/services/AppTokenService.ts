import { env } from "cloudflare:workers";
import { AppRepository } from "../repositories/AppRepository";
import { AppTokenRepository } from "../repositories/AppTokenRepository";
import { hashAppToken } from "../app-token-hash";
import { normalizeTokenScope, normalizeTokenScopes } from "../app-token-scopes";
import { PublicError } from "@/server/errors";

type CreateAppTokenInput = {
  appId: string;
  scopes: string[];
  expiresAt: string | null;
};

const MAX_SCOPES = 20;
const TOKEN_PREFIX_SCHEME = "eat_";
const TOKEN_PREFIX_RANDOM_LENGTH = 4;

function validateScopes(scopes: string[]): void {
  const normalizedScopes: string[] = [];
  for (const scope of scopes) {
    const normalizedScope = normalizeTokenScope(scope);
    if (!normalizedScope) {
      throw new PublicError("INVALID_TOKEN_SCOPE", `Invalid scope: ${scope}`);
    }

    normalizedScopes.push(normalizedScope);
  }

  const uniqueScopes = [...new Set(normalizedScopes)];
  if (uniqueScopes.length === 0) {
    throw new PublicError(
      "TOKEN_SCOPE_REQUIRED",
      "At least one scope is required",
    );
  }

  if (uniqueScopes.length > MAX_SCOPES) {
    throw new PublicError(
      "TOKEN_SCOPE_LIMIT_EXCEEDED",
      `No more than ${MAX_SCOPES} scopes are allowed`,
    );
  }
}

function parseExpiresAt(expiresAt: string | null): Date | null {
  if (!expiresAt) {
    return null;
  }

  const parsed = new Date(expiresAt);
  if (Number.isNaN(parsed.getTime())) {
    throw new PublicError("INVALID_EXPIRATION_DATE", "Invalid expiration date");
  }

  if (parsed.getTime() <= Date.now()) {
    throw new PublicError(
      "EXPIRATION_IN_PAST",
      "Expiration date must be in the future",
    );
  }

  return parsed;
}

function generateTokenSecret(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function generatePlaintextToken(): string {
  return `eat_${generateTokenSecret()}`;
}

function tokenPrefix(
  token: string,
  randomLength = TOKEN_PREFIX_RANDOM_LENGTH,
): string {
  if (!token.startsWith(TOKEN_PREFIX_SCHEME)) {
    return token.slice(0, randomLength);
  }

  const randomStart = TOKEN_PREFIX_SCHEME.length;
  const randomEnd = randomStart + randomLength;
  return `${TOKEN_PREFIX_SCHEME}${token.slice(randomStart, randomEnd)}`;
}

async function list() {
  const tokens = await AppTokenRepository.findAllForAdmin();
  return { tokens };
}

async function create(
  data: CreateAppTokenInput,
  createdByUserId: string | null,
) {
  const app = await AppRepository.findById(data.appId);
  if (!app) {
    throw new PublicError("APP_NOT_FOUND", "App not found");
  }

  validateScopes(data.scopes);
  const scopes = normalizeTokenScopes(data.scopes);
  const expiresAt = parseExpiresAt(data.expiresAt);

  const plaintextToken = generatePlaintextToken();
  const tokenPrefixValue = tokenPrefix(plaintextToken);
  const hash = await hashAppToken(plaintextToken, env.BETTER_AUTH_SECRET);

  const id = crypto.randomUUID();
  await AppTokenRepository.create({
    id,
    appId: app.id,
    tokenHash: hash,
    tokenPrefix: tokenPrefixValue,
    scopes,
    createdBy: createdByUserId,
    expiresAt,
  });

  return {
    id,
    appId: app.id,
    appSlug: app.appId,
    appName: app.name,
    token: plaintextToken,
    tokenPrefix: tokenPrefixValue,
    scopes,
    expiresAt,
  };
}

async function revoke(tokenId: string) {
  const existing = await AppTokenRepository.findById(tokenId);
  if (!existing) {
    throw new PublicError("TOKEN_NOT_FOUND", "Token not found");
  }

  if (existing.revokedAt) {
    return { alreadyRevoked: true };
  }

  await AppTokenRepository.revoke(tokenId);
  return { alreadyRevoked: false };
}

export const AppTokenService = {
  list,
  create,
  revoke,
} as const;
