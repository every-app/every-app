import { env } from "cloudflare:workers";
import { AppRepository } from "../repositories/AppRepository";
import { UserPatRepository } from "../repositories/UserPatRepository";
import { hashUserPat } from "../user-pat-hash";
import { PublicError } from "@/server/errors";
import { emit } from "@/server/events/bus";
import { catalogue } from "@/server/events/catalogue";
import { userActor, userSubject } from "@/server/events/subjects";
import { platformPolicy } from "@/server/platform-policy";
import {
  TOKEN_ACCESS_SCOPES,
  type TokenAccess,
  type TokenExpiryDays,
} from "@/server/user-pat-scopes";

type CreateUserPatInput = {
  userId: string;
  organizationId: string;
  appRowId?: string | null;
  name: string;
  /** Default: full. */
  access?: TokenAccess;
  /** Default: 90 days, a deploy key 30. */
  expiresInDays?: TokenExpiryDays;
};

const PAT_PREFIX_SCHEME = "epat_";
const TOKEN_PREFIX_RANDOM_LENGTH = 4;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_DAYS = 90;
// CI holds a deploy key: shorter-lived by default.
const DEPLOY_KEY_TTL_DAYS = 30;

function generateTokenSecret(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function generatePlaintextToken(): string {
  return `${PAT_PREFIX_SCHEME}${generateTokenSecret()}`;
}

function tokenPrefix(
  token: string,
  scheme = PAT_PREFIX_SCHEME,
  randomLength = TOKEN_PREFIX_RANDOM_LENGTH,
): string {
  if (!token.startsWith(scheme)) {
    return token.slice(0, randomLength);
  }

  const randomStart = scheme.length;
  const randomEnd = randomStart + randomLength;
  return `${scheme}${token.slice(randomStart, randomEnd)}`;
}

async function create(data: CreateUserPatInput) {
  const access = data.access ?? "full";
  // A deploy key deploys and does nothing else (the perimeter and /mcp
  // refuse it), and only where the deploy API exists.
  if (access === "deploy" && !platformPolicy(env).thirdPartyDeploys) {
    throw new PublicError(
      "DEPLOY_KEYS_UNAVAILABLE",
      "This gateway doesn't take third-party deploys",
    );
  }

  let appRowId = data.appRowId ?? null;
  let appSlug: string | null = null;
  let appName: string | null = null;

  if (appRowId) {
    const app = await AppRepository.findById(appRowId, data.organizationId);
    if (!app) {
      throw new PublicError("APP_NOT_FOUND", "App not found");
    }
    appRowId = app.id;
    appSlug = app.appSlug;
    appName = app.name;
  }

  const scopes = [...TOKEN_ACCESS_SCOPES[access]];
  const days =
    data.expiresInDays ??
    (access === "deploy" ? DEPLOY_KEY_TTL_DAYS : DEFAULT_TTL_DAYS);
  const expiresAt = new Date(Date.now() + days * DAY_MS);
  const plaintext = generatePlaintextToken();
  const tokenPrefixValue = tokenPrefix(plaintext);
  const tokenHash = await hashUserPat(plaintext, env.BETTER_AUTH_SECRET);
  const id = crypto.randomUUID();

  await UserPatRepository.create({
    id,
    userId: data.userId,
    organizationId: data.organizationId,
    appRowId,
    name: data.name,
    tokenHash,
    tokenPrefix: tokenPrefixValue,
    scopes,
    expiresAt,
  });

  const row = await UserPatRepository.findByIdForUser(id, data.userId);
  if (!row) {
    throw new PublicError("TOKEN_NOT_FOUND", "Created token not found");
  }
  // The row's id, name, scopes, app and expiry: never the value or its hash.
  await emit(async () => ({
    organizationId: data.organizationId,
    actor: await userActor(data.userId),
    ...catalogue.tokenCreated({
      id,
      name: data.name,
      scopes,
      appId: appSlug,
      expiresAt,
      user: await userSubject(data.userId),
    }),
  }));

  return {
    plaintext,
    row: {
      ...row,
      appId: row.appRowId,
      appSlug,
      appName,
    },
  };
}

async function verify(plaintext: string) {
  const token = plaintext.trim();
  if (!token.startsWith(PAT_PREFIX_SCHEME)) return null;

  const tokenHash = await hashUserPat(token, env.BETTER_AUTH_SECRET);
  return UserPatRepository.findActiveByTokenHash(tokenHash);
}

async function revoke(id: string, userId: string) {
  const existing = await UserPatRepository.findByIdForUser(id, userId);
  if (!existing) {
    throw new PublicError("TOKEN_NOT_FOUND", "Token not found");
  }

  if (existing.revokedAt) {
    return { alreadyRevoked: true };
  }

  await UserPatRepository.revoke(id, userId);
  await emit(async () => ({
    organizationId: existing.organizationId,
    actor: await userActor(userId),
    ...catalogue.tokenRevoked({
      id: existing.id,
      name: existing.name,
      user: await userSubject(userId),
    }),
  }));
  return { alreadyRevoked: false };
}

async function listForUser(userId: string, organizationId: string) {
  const tokens = await UserPatRepository.listForUser(userId, organizationId);
  return {
    tokens: tokens.map(({ appRowId, ...token }) => ({
      ...token,
      appId: appRowId,
    })),
    // The tokens page offers deploy keys only where they deploy.
    deployKeys: platformPolicy(env).thirdPartyDeploys,
  };
}

export const UserPatService = {
  create,
  verify,
  revoke,
  listForUser,
} as const;
