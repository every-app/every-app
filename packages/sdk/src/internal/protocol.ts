/**
 * @every-app/sdk/internal — Every App platform protocol internals.
 *
 * This subpath is for the Every App platform itself (gateway, perimeter, CLI),
 * not for app authors. It owns the wire constants, claim shapes, claim codecs,
 * and gateway-side JWT minters shared by the platform packages.
 */
import { SignJWT, importPKCS8, type JWTPayload } from "jose";
import type { ToolCallClaim } from "./tools.js";

export const IDENTITY_ALG = "RS256";
export const IDENTITY_KEY_ID = "everyapp-identity";
export const IDENTITY_DEV_KEY_ID = "everyapp-identity-dev";
export const IDENTITY_HEADER = "x-everyapp-identity";
export const PUBLIC_HEADER = "x-everyapp-public";
/**
 * Carries the gateway's system token on its own calls to an app (the tools
 * catalog fetch). Never an identity: no user, and it only opens the endpoint
 * named by its `purpose` claim.
 */
export const SYSTEM_HEADER = "x-everyapp-system";
/** 120-second lifetime — caps revocation staleness while surviving clock skew. */
export const IDENTITY_TTL_SECONDS = 120;
/** System tokens are minted per call and live at most a minute. */
export const SYSTEM_TOKEN_TTL_SECONDS = 60;
/** Env var carrying the app id used as the expected identity audience. */
export const APP_ID_ENV = "EVERYAPP_APP_ID";
/** Default env var carrying a JSON array of SPKI PEM public keys. */
export const PUBLIC_KEYS_ENV = "EVERYAPP_IDENTITY_PUBLIC_KEYS";
/** Env var carrying the expected gateway issuer for user identity verification. */
export const ISSUER_ENV = "EVERYAPP_IDENTITY_ISSUER";
/** When set to `1` or `true` in the worker env, the dev identity kid is accepted. */
export const DEV_ENV = "EVERYAPP_DEV";
/** `sub` claim the gateway mints public-route markers with. */
export const PUBLIC_MARKER_SUB = "public";
/** `sub` claim of gateway system tokens. */
export const SYSTEM_TOKEN_SUB = "system";

export type IdentityChannel = "web" | "api" | "mcp" | "agent";
export type IdentityTokenType = "user" | "public" | "system";
/** What a system token may open. One purpose per token. */
export type SystemTokenPurpose = "tools.list";

/** The actor on whose behalf the request is made (user, MCP client, agent). */
export interface IdentityActor {
  sub: string;
}

export interface IdentitySubject {
  sub: string;
  email: string;
  orgId: string;
  orgRole: string;
}

export interface EveryAppUser {
  /** User id (the `sub` claim). */
  id: string;
  email: string;
  orgId: string;
  orgRole: string;
  channel: IdentityChannel;
  /** The acting principal (user, or `mcp:<client>` / agent). */
  actor: IdentityActor;
  scopes: string[];
  jti: string;
  /**
   * Set only on an MCP tool call (`channel: "mcp"`): the one call this
   * identity was minted for.
   */
  toolCall?: ToolCallClaim;
}

export interface IdentityClaims extends JWTPayload {
  typ: "user";
  email: string;
  org_id: string;
  org_role: string;
  chan: IdentityChannel;
  act: IdentityActor;
  scopes: string[];
  jti: string;
  /** Tool-call binding; only the gateway's ToolBus mints it. */
  tc?: ToolCallClaim;
}

export interface SystemClaims extends JWTPayload {
  typ: "system";
  purpose: SystemTokenPurpose;
  jti: string;
}

export interface PublicMarkerClaims extends JWTPayload {
  typ: "public";
  pub: true;
  jti: string;
}

export class ProtocolClaimsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolClaimsError";
  }
}

export function identitySubjectToClaims(
  subject: IdentitySubject,
  opts: {
    channel?: IdentityChannel;
    actor?: IdentityActor;
    scopes?: string[];
    toolCall?: ToolCallClaim;
    jti: string;
  },
): IdentityClaims {
  return {
    typ: "user",
    email: subject.email,
    org_id: subject.orgId,
    org_role: subject.orgRole,
    chan: opts.channel ?? "web",
    act: opts.actor ?? { sub: subject.sub },
    scopes: opts.scopes ?? ["*"],
    jti: opts.jti,
    ...(opts.toolCall
      ? { tc: { id: opts.toolCall.id, name: opts.toolCall.name } }
      : {}),
  };
}

function parseToolCallClaim(value: unknown): ToolCallClaim | undefined {
  if (value === undefined) return undefined;
  const claim = value as { id?: unknown; name?: unknown } | null;
  if (
    !claim ||
    typeof claim !== "object" ||
    typeof claim.id !== "string" ||
    typeof claim.name !== "string" ||
    !claim.id ||
    !claim.name
  ) {
    throw new ProtocolClaimsError("identity token has a malformed tc claim");
  }
  return { id: claim.id, name: claim.name };
}

export function identityClaimsToEveryAppUser(
  payload: JWTPayload,
): EveryAppUser {
  if (payload.typ !== "user") {
    throw new ProtocolClaimsError("identity token has wrong typ");
  }
  const sub = payload.sub;
  const email = payload.email as string | undefined;
  const orgId = payload.org_id as string | undefined;
  const orgRole = payload.org_role as string | undefined;
  if (!sub || !email || !orgId || !orgRole) {
    throw new ProtocolClaimsError("identity token missing required claims");
  }
  const chan = (payload.chan as IdentityChannel | undefined) ?? "web";
  const act = (payload.act as { sub?: string } | undefined) ?? { sub };
  const scopes = Array.isArray(payload.scopes)
    ? payload.scopes.filter(
        (scope): scope is string => typeof scope === "string",
      )
    : ["*"];
  const toolCall = parseToolCallClaim(payload.tc);
  return {
    id: sub,
    email,
    orgId,
    orgRole,
    channel: chan,
    actor: { sub: act.sub ?? sub },
    scopes,
    jti: (payload.jti as string | undefined) ?? "",
    ...(toolCall ? { toolCall } : {}),
  };
}

export function publicMarkerClaims(jti: string): PublicMarkerClaims {
  return { typ: "public", pub: true, jti };
}

export function assertPublicMarkerClaims(payload: JWTPayload): void {
  if (payload.typ !== "public") {
    throw new ProtocolClaimsError("public marker has wrong typ");
  }
  if (payload.pub !== true || payload.sub !== PUBLIC_MARKER_SUB) {
    throw new ProtocolClaimsError("token is not a public-route marker");
  }
}

/**
 * A system token opens exactly one endpoint and lives at most
 * {@link SYSTEM_TOKEN_TTL_SECONDS}: a leaked one is short-lived and useless
 * anywhere else.
 */
export function assertSystemClaims(
  payload: JWTPayload,
  purpose: SystemTokenPurpose,
): SystemClaims {
  if (payload.typ !== "system" || payload.sub !== SYSTEM_TOKEN_SUB) {
    throw new ProtocolClaimsError("token is not a system token");
  }
  if (payload.purpose !== purpose) {
    throw new ProtocolClaimsError(
      `system token purpose "${String(payload.purpose)}" is not "${purpose}"`,
    );
  }
  if (
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number" ||
    payload.exp - payload.iat > SYSTEM_TOKEN_TTL_SECONDS
  ) {
    throw new ProtocolClaimsError(
      `system token must expire within ${SYSTEM_TOKEN_TTL_SECONDS}s of issue`,
    );
  }
  return payload as SystemClaims;
}

export interface MintIdentityOptions {
  subject: IdentitySubject;
  /** The app id this token is scoped to — becomes the `aud` claim. */
  audience: string;
  issuer: string;
  channel?: IdentityChannel;
  actor?: IdentityActor;
  scopes?: string[];
  /** Bind the token to one MCP tool call (`tc` claim). ToolBus only. */
  toolCall?: ToolCallClaim;
  ttlSeconds?: number;
  now?: number;
  /** Header kid. Defaults to the production kid; dev mints with the dev kid. */
  keyId?: string;
}

type SigningKey = Awaited<ReturnType<typeof importPKCS8>>;

let cachedPrivateKey: { pem: string; key: SigningKey } | null = null;

async function loadPrivateKey(privateKeyPem: string): Promise<SigningKey> {
  const pem = privateKeyPem.replace(/\\n/g, "\n");
  if (cachedPrivateKey && cachedPrivateKey.pem === pem) {
    return cachedPrivateKey.key;
  }
  const key = await importPKCS8(pem, IDENTITY_ALG);
  cachedPrivateKey = { pem, key };
  return key;
}

/**
 * Mint an identity JWT. Returns the compact JWS string to inject as
 * `x-everyapp-identity`.
 */
export async function mintIdentityJwt(
  privateKeyPem: string,
  opts: MintIdentityOptions,
): Promise<string> {
  const key = await loadPrivateKey(privateKeyPem);
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  const ttl = opts.ttlSeconds ?? IDENTITY_TTL_SECONDS;
  const jti = crypto.randomUUID();

  return new SignJWT(
    identitySubjectToClaims(opts.subject, {
      channel: opts.channel,
      actor: opts.actor,
      scopes: opts.scopes,
      toolCall: opts.toolCall,
      jti,
    }),
  )
    .setProtectedHeader({
      alg: IDENTITY_ALG,
      kid: opts.keyId ?? IDENTITY_KEY_ID,
    })
    .setIssuer(opts.issuer)
    .setSubject(opts.subject.sub)
    .setAudience(opts.audience)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + ttl)
    .sign(key);
}

export interface MintPublicMarkerOptions {
  /** The app id this marker is scoped to — becomes the `aud` claim. */
  audience: string;
  issuer: string;
  ttlSeconds?: number;
  now?: number;
  /** Header kid. Defaults to the production kid; dev mints with the dev kid. */
  keyId?: string;
}

/**
 * Mint the public-route marker for `x-everyapp-public`. A bare header value
 * is never a trust source, so the marker is a signed, short-lived, app-scoped
 * JWT with `pub: true` and `typ: "public"` that the SDK verifies exactly like
 * an identity token.
 */
export async function mintPublicMarkerJwt(
  privateKeyPem: string,
  opts: MintPublicMarkerOptions,
): Promise<string> {
  const key = await loadPrivateKey(privateKeyPem);
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  const ttl = opts.ttlSeconds ?? IDENTITY_TTL_SECONDS;

  return new SignJWT(publicMarkerClaims(crypto.randomUUID()))
    .setProtectedHeader({
      alg: IDENTITY_ALG,
      kid: opts.keyId ?? IDENTITY_KEY_ID,
    })
    .setIssuer(opts.issuer)
    .setSubject(PUBLIC_MARKER_SUB)
    .setAudience(opts.audience)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + ttl)
    .sign(key);
}

export interface MintSystemTokenOptions {
  /** The app id the token is for — becomes the `aud` claim. */
  audience: string;
  issuer: string;
  purpose: SystemTokenPurpose;
  /** At most {@link SYSTEM_TOKEN_TTL_SECONDS}. */
  ttlSeconds?: number;
  now?: number;
  /** Header kid. Defaults to the production kid; dev mints with the dev kid. */
  keyId?: string;
}

/**
 * Mint the gateway's system token for `x-everyapp-system`: no user, one
 * purpose, one app, one minute. The SDK only accepts it on the endpoint its
 * purpose names, and never as an identity.
 */
export async function mintSystemJwt(
  privateKeyPem: string,
  opts: MintSystemTokenOptions,
): Promise<string> {
  const ttl = opts.ttlSeconds ?? SYSTEM_TOKEN_TTL_SECONDS;
  if (ttl <= 0 || ttl > SYSTEM_TOKEN_TTL_SECONDS) {
    throw new RangeError(
      `system tokens live at most ${SYSTEM_TOKEN_TTL_SECONDS}s (got ${ttl})`,
    );
  }
  const key = await loadPrivateKey(privateKeyPem);
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  const claims: SystemClaims = {
    typ: "system",
    purpose: opts.purpose,
    jti: crypto.randomUUID(),
  };

  return new SignJWT(claims)
    .setProtectedHeader({
      alg: IDENTITY_ALG,
      kid: opts.keyId ?? IDENTITY_KEY_ID,
    })
    .setIssuer(opts.issuer)
    .setSubject(SYSTEM_TOKEN_SUB)
    .setAudience(opts.audience)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + ttl)
    .sign(key);
}
