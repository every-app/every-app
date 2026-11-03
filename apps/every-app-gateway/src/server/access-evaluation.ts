/**
 * Cloudflare Access asks the Gateway who is a member.
 *
 * `everyapp access on` gives the Access policy in front of the Gateway and
 * its apps one rule: an External Evaluation rule pointing here. After a
 * person signs in to Access (the one-time PIN, Sign in with Cloudflare),
 * Access POSTs `{ token }` to `/access-evaluation/evaluate`: a JWT it signed
 * with the team's key, carrying the person's identity and a nonce. The
 * Gateway answers `{ token }`, a JWT it signs with its own key, saying
 * `success: true` only for
 *
 *  - an account with that email that isn't deactivated and belongs to an
 *    organization here, or
 *  - a pending, unexpired invitation for that email.
 *
 * Access checks the answer's signature against `/access-evaluation/keys`,
 * its expiry and its nonce, and lets the person in only on `true`. So the
 * Gateway's members and invitations are the one list both Access and the
 * Gateway enforce: an invitee gets past Access as soon as they are invited,
 * and someone removed or deactivated is refused at their next Access
 * sign-in. Access still asks for a sign-in first, and the Gateway still
 * checks membership itself on every session (membership.ts): two checks,
 * one list.
 *
 * Both paths are let through Access without a login (access-plan.ts):
 * Access calls them from its own servers. The evaluate path trusts nothing
 * it isn't sure Access signed: an RS256 signature by a key in the team's
 * JWKS (the same keys the outer ring's assertions use), an expiry and a
 * nonce. Its answer says yes or no about the email in that token, to
 * whoever holds the token, bound to that token's nonce; a token that
 * doesn't verify gets no answer. Off (404) unless the outer ring is
 * configured (CLOUDFLARE_ACCESS_TEAM_DOMAIN and CLOUDFLARE_ACCESS_AUD).
 *
 * The signing key is one RSA key pair, made on first use and kept in D1
 * with its private half sealed (secrets/sealed.ts); Access accepts RSA keys
 * only. See the Cloudflare docs, "External Evaluation rules".
 */
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import {
  calculateJwkThumbprint,
  decodeProtectedHeader,
  errors,
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  SignJWT,
  type JWK,
  type JWTPayload,
} from "jose";
import { logEvent } from "@every-app/perimeter";
import { accessConfigFromEnv } from "@/auth/cloudflare-access";
import { jwksClientFor } from "@/auth/cloudflare-access/jwt";
import { mayUseGateway } from "@/auth/identity-membership";
import { db } from "@/db";
import { accessEvaluationKey } from "@/db/schema";
import { open, seal } from "@/server/secrets/sealed";

const ACCESS_EVALUATION_PATHS = {
  evaluate: "/access-evaluation/evaluate",
  keys: "/access-evaluation/keys",
} as const;

const ALGORITHM = "RS256";
/** How long Access may take the answer to be true. */
const ANSWER_LIFETIME_SECONDS = 60;
/** Leeway on the incoming token's `exp` for clocks a little apart. */
const CLOCK_TOLERANCE_SECONDS = 60;
/** The largest request body read: Access's token is a few kilobytes. */
const MAX_BODY_BYTES = 16 * 1024;
const KEY_ROW_ID = "current";

const noStore = { "cache-control": "no-store" };

interface SigningKey {
  kid: string;
  publicJwk: JWK;
  privateKey: CryptoKey;
}

let cachedKey: Promise<SigningKey> | null = null;

export function resetAccessEvaluationKeyForTests(): void {
  cachedKey = null;
}

async function readKeyRow(): Promise<SigningKey | null> {
  const row = await db.query.accessEvaluationKey.findFirst({
    where: eq(accessEvaluationKey.id, KEY_ROW_ID),
  });
  if (!row) return null;
  const opened = await open(row.privateJwkSealed, env);
  if (opened === null) {
    // Sealed under an earlier BETTER_AUTH_SECRET: replaced by a new pair,
    // which the keys URL publishes, so Access recovers by itself.
    logEvent("access.evaluation_key_replaced", { kid: row.kid });
    await db
      .delete(accessEvaluationKey)
      .where(
        and(
          eq(accessEvaluationKey.id, KEY_ROW_ID),
          eq(accessEvaluationKey.kid, row.kid),
        ),
      );
    return null;
  }
  const privateKey = await importJWK(JSON.parse(opened) as JWK, ALGORITHM);
  if (!(privateKey instanceof CryptoKey)) throw new Error("not an RSA key");
  return {
    kid: row.kid,
    publicJwk: JSON.parse(row.publicJwk) as JWK,
    privateKey,
  };
}

/** The key, made and stored the first time; two isolates racing keep the first row. */
async function loadOrCreateKey(): Promise<SigningKey> {
  const existing = await readKeyRow();
  if (existing) return existing;
  const pair = await generateKeyPair(ALGORITHM, {
    extractable: true,
    modulusLength: 2048,
  });
  const publicJwk = await exportJWK(pair.publicKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  const privateJwk = await exportJWK(pair.privateKey);
  await db
    .insert(accessEvaluationKey)
    .values({
      id: KEY_ROW_ID,
      kid,
      publicJwk: JSON.stringify(publicJwk),
      privateJwkSealed: await seal(JSON.stringify(privateJwk), env),
    })
    .onConflictDoNothing();
  const stored = await readKeyRow();
  if (!stored) throw new Error("The Access evaluation key wasn't stored");
  return stored;
}

function signingKey(): Promise<SigningKey> {
  if (!cachedKey) {
    cachedKey = loadOrCreateKey();
    cachedKey.catch(() => {
      cachedKey = null;
    });
  }
  return cachedKey;
}

/** The email of the person Access asks about: its `identity`, else the token's own claim. */
function emailOf(claims: JWTPayload): string | null {
  const identity = claims["identity"];
  const fromIdentity =
    identity && typeof identity === "object"
      ? (identity as { email?: unknown }).email
      : undefined;
  const email = fromIdentity ?? claims["email"];
  return typeof email === "string" && email.trim() ? email.trim() : null;
}

/** The claims of a token the team's Access signed, or null for anything else. */
async function verifyAccessRequest(
  token: string,
  certsUrl: string,
): Promise<JWTPayload | null> {
  let kid: unknown;
  try {
    const header = decodeProtectedHeader(token);
    if (header.alg !== ALGORITHM) return null;
    kid = header.kid;
  } catch {
    return null;
  }
  if (typeof kid !== "string" || !kid) return null;
  const keys = await jwksClientFor(certsUrl).keysFor(kid);
  if (!keys) return null;
  try {
    const { payload } = await jwtVerify(token, keys, {
      algorithms: [ALGORITHM],
      requiredClaims: ["exp", "nonce"],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });
    return typeof payload["nonce"] === "string" && payload["nonce"]
      ? payload
      : null;
  } catch (error) {
    if (!(error instanceof errors.JOSEError)) throw error;
    return null;
  }
}

async function readToken(request: Request): Promise<string | null> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const token = (JSON.parse(text) as { token?: unknown }).token;
    return typeof token === "string" && token ? token : null;
  } catch {
    return null;
  }
}

async function evaluate(request: Request, certsUrl: string): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }
  const token = await readToken(request);
  const claims = token ? await verifyAccessRequest(token, certsUrl) : null;
  if (!claims) {
    logEvent("access.evaluation_refused", { reason: "invalid_token" }, "warn");
    return Response.json(
      { error: "invalid_token" },
      { status: 400, headers: noStore },
    );
  }
  const email = emailOf(claims);
  const member = email ? await mayUseGateway(email) : false;
  logEvent("access.evaluated", { member });
  const key = await signingKey();
  const now = Math.floor(Date.now() / 1000);
  const answer = await new SignJWT({
    success: member,
    nonce: claims["nonce"] as string,
  })
    .setProtectedHeader({ alg: ALGORITHM, kid: key.kid })
    .setIssuedAt(now)
    .setExpirationTime(now + ANSWER_LIFETIME_SECONDS)
    .sign(key.privateKey);
  return Response.json({ token: answer }, { headers: noStore });
}

async function publishKeys(request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET" } });
  }
  const key = await signingKey();
  return Response.json(
    {
      keys: [{ ...key.publicJwk, kid: key.kid, alg: ALGORITHM, use: "sig" }],
    },
    { headers: noStore },
  );
}

/**
 * `/access-evaluation/*` on the Gateway's host: the answer, or null for a
 * path that isn't one of the two (the caller's 404). 404 too while the
 * outer ring isn't configured.
 */
export async function serveAccessEvaluation(
  request: Request,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (
    pathname !== ACCESS_EVALUATION_PATHS.evaluate &&
    pathname !== ACCESS_EVALUATION_PATHS.keys
  ) {
    return null;
  }
  const { outerRing } = accessConfigFromEnv();
  if (!outerRing) return null;
  return pathname === ACCESS_EVALUATION_PATHS.keys
    ? publishKeys(request)
    : evaluate(request, outerRing.certsUrl);
}
