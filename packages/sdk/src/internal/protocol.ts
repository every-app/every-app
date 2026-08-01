/**
 * @every-app/sdk/internal — Every App platform protocol internals.
 *
 * This subpath is for the Every App platform itself (gateway, perimeter, CLI),
 * not for app authors. It owns the wire constants, claim shapes, claim codecs,
 * and gateway-side JWT minters shared by the platform packages.
 */
import { SignJWT, importPKCS8, type JWTPayload } from "jose";

export const IDENTITY_ALG = "RS256";
export const IDENTITY_KEY_ID = "everyapp-identity";
export const IDENTITY_DEV_KEY_ID = "everyapp-identity-dev";
export const IDENTITY_HEADER = "x-everyapp-identity";
export const PUBLIC_HEADER = "x-everyapp-public";
/** 120-second lifetime — caps revocation staleness while surviving clock skew. */
export const IDENTITY_TTL_SECONDS = 120;
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

export type IdentityChannel = "web" | "api" | "mcp" | "agent";
export type IdentityTokenType = "user" | "public";

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
  };
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
  return {
    id: sub,
    email,
    orgId,
    orgRole,
    channel: chan,
    actor: { sub: act.sub ?? sub },
    scopes,
    jti: (payload.jti as string | undefined) ?? "",
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

export interface MintIdentityOptions {
  subject: IdentitySubject;
  /** The app id this token is scoped to — becomes the `aud` claim. */
  audience: string;
  issuer: string;
  channel?: IdentityChannel;
  actor?: IdentityActor;
  scopes?: string[];
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
