import { IDENTITY_HEADER, ORG_HEADER, SHARED_ENV } from "../internal/index.js";

/**
 * Whom a call through the gateway is for, which decides the organization
 * it counts against:
 *
 *  - the inbound `Request`: its person, by the identity the gateway put on
 *    it (forwarded as is);
 *  - `{ background: true, organizationId }`: work no request started (a
 *    cron, a Workflow step, a queue). A shared app's Worker serves every
 *    organization, so it names the one the work is for, which the gateway
 *    checks is active and has a live member. An organization's own app may
 *    leave it out (the gateway knows its organization) and may only name
 *    its own.
 */
export type GatewayCallFor =
  | Request
  | { background: true; organizationId?: string };

/**
 * A gateway call that doesn't say whom it is for where it must: from a
 * shared app's Worker, with neither the request nor an organization.
 */
export class AttributionError extends Error {
  readonly code = "attribution_required";
  constructor(message: string) {
    super(message);
    this.name = "AttributionError";
  }
}

/**
 * Check `target` before any call is made: a shared app's Worker must pass
 * the request or name the organization, and anything else passed must be
 * one of the two shapes.
 */
export function checkAttribution(
  env: object,
  target: GatewayCallFor | undefined,
  what: string,
): void {
  if (target !== undefined && !isRequest(target)) {
    if (target === null || typeof target !== "object" || !target.background) {
      throw new AttributionError(
        `${what}: \`for\` is the inbound Request or { background: true, organizationId }.`,
      );
    }
    if (
      target.organizationId !== undefined &&
      !nonEmpty(target.organizationId)
    ) {
      throw new AttributionError(
        `${what}: { background: true, organizationId } needs a non-empty organization id.`,
      );
    }
  }
  if (!isSharedWorker(env)) return;
  if (target === undefined || (!isRequest(target) && !target.organizationId)) {
    throw new AttributionError(
      `${what} in a shared app's Worker serves every organization, so it must say whom the call is for: for: request, or for: { background: true, organizationId } for work no request started.`,
    );
  }
}

/**
 * Put the call's attribution on its headers: the request's identity, or the
 * background work's organization, and never one the app set itself.
 */
export function applyAttribution(
  headers: Headers,
  target: GatewayCallFor | undefined,
): void {
  headers.delete(IDENTITY_HEADER);
  headers.delete(ORG_HEADER);
  if (target === undefined) return;
  if (isRequest(target)) {
    const identity = target.headers.get(IDENTITY_HEADER);
    if (identity) headers.set(IDENTITY_HEADER, identity);
    return;
  }
  if (target.organizationId) headers.set(ORG_HEADER, target.organizationId);
}

function isSharedWorker(env: object): boolean {
  const value = (env as Record<string, unknown>)[SHARED_ENV];
  return value === "1" || value === "true" || value === true;
}

// Duck-typed: a Request from another realm (a test runner, a polyfill) is
// still the request.
/** Whether `for` is the inbound request (rather than background work). */
export function isRequest(value: unknown): value is Request {
  return (
    typeof value === "object" &&
    value !== null &&
    "headers" in value &&
    typeof (value as Request).headers?.get === "function"
  );
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
