import { env } from "cloudflare:workers";
import { AppTokenRepository } from "../repositories/AppTokenRepository";
import { hashAppToken } from "../app-token-hash";
import { normalizeTokenScopes } from "../app-token-scopes";
import { PublicError } from "@/server/errors";

type IssueDeployTokenInput = {
  organizationId: string;
  createdBy: string | null;
  expiresAt?: string | null;
};

type VerifiedDeployToken = {
  organizationId: string;
  scopes: string[];
};

const DEPLOY_TOKEN_PREFIX_SCHEME = "eak_";
const TOKEN_PREFIX_RANDOM_LENGTH = 4;
const DEPLOY_TOKEN_SCOPES = ["apps:register", "apps:deploy"];

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

function generatePlaintextToken(prefix: string): string {
  return `${prefix}${generateTokenSecret()}`;
}

function tokenPrefix(
  token: string,
  scheme: string,
  randomLength = TOKEN_PREFIX_RANDOM_LENGTH,
): string {
  if (!token.startsWith(scheme)) {
    return token.slice(0, randomLength);
  }

  const randomStart = scheme.length;
  const randomEnd = randomStart + randomLength;
  return `${scheme}${token.slice(randomStart, randomEnd)}`;
}

async function list(organizationId: string) {
  const records = await AppTokenRepository.findAllForAdmin(organizationId);
  const tokens = records.map(({ appRowId, ...token }) => ({
    ...token,
    appId: appRowId,
  }));
  return { tokens };
}

async function issueDeployToken(data: IssueDeployTokenInput) {
  const scopes = normalizeTokenScopes(DEPLOY_TOKEN_SCOPES);
  const expiresAt = parseExpiresAt(data.expiresAt ?? null);

  const plaintextToken = generatePlaintextToken(DEPLOY_TOKEN_PREFIX_SCHEME);
  const tokenPrefixValue = tokenPrefix(
    plaintextToken,
    DEPLOY_TOKEN_PREFIX_SCHEME,
  );
  const hash = await hashAppToken(plaintextToken, env.BETTER_AUTH_SECRET);

  const id = crypto.randomUUID();
  await AppTokenRepository.create({
    id,
    appRowId: null,
    organizationId: data.organizationId,
    tokenHash: hash,
    tokenPrefix: tokenPrefixValue,
    scopes,
    createdBy: data.createdBy,
    expiresAt,
  });

  return {
    id,
    appId: null,
    appSlug: null,
    appName: null,
    token: plaintextToken,
    tokenPrefix: tokenPrefixValue,
    scopes,
    expiresAt,
  };
}

async function verifyDeployToken(
  rawToken: string,
): Promise<VerifiedDeployToken | null> {
  const token = rawToken.trim();
  if (!token.startsWith(DEPLOY_TOKEN_PREFIX_SCHEME)) {
    return null;
  }

  const hash = await hashAppToken(token, env.BETTER_AUTH_SECRET);
  const deployToken =
    await AppTokenRepository.findActiveDeployByTokenHash(hash);
  if (!deployToken) {
    return null;
  }

  const scopes = normalizeTokenScopes(deployToken.scopes);
  if (
    !DEPLOY_TOKEN_SCOPES.every((requiredScope) =>
      scopes.includes(requiredScope),
    )
  ) {
    return null;
  }

  await AppTokenRepository.touchLastUsed(
    deployToken.id,
    deployToken.organizationId,
  );

  return {
    organizationId: deployToken.organizationId,
    scopes,
  };
}

async function revoke(tokenId: string, organizationId: string) {
  const existing = await AppTokenRepository.findById(tokenId, organizationId);
  if (!existing) {
    throw new PublicError("TOKEN_NOT_FOUND", "Token not found");
  }

  if (existing.revokedAt) {
    return { alreadyRevoked: true };
  }

  await AppTokenRepository.revoke(tokenId, organizationId);
  return { alreadyRevoked: false };
}

export const AppTokenService = {
  list,
  issueDeployToken,
  verifyDeployToken,
  revoke,
} as const;
