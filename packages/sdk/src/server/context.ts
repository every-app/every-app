/**
 * The request context: whom the app is serving, kept for the whole of a
 * request's work (every `await`, `ctx.waitUntil()`, a streaming body) in an
 * `AsyncLocalStorage`, which every Every App Worker has (`nodejs_compat`).
 *
 * `everyApp()` opens it around the handler and around each tool call, with
 * the verified user and the request the Gateway forwarded. Deeper in the
 * app, `currentUser()` reads the user without the request, and every call
 * back to the Gateway (`integrationFetch`, `ai`, `sendEmail`, `emit`, ...)
 * is attributed to that person without a `for`.
 *
 * Work no request started (a cron, a Workflow step, a queue consumer, a
 * Durable Object alarm) has no context of its own: it runs under
 * `withOrganization(organizationId, fn)`, which makes every Gateway call
 * inside it that organization's background work. A Gateway call with
 * neither is refused before it is made ({@link RequestContextError}): the
 * SDK never acts as nobody.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { EveryAppUser } from "../internal/index.js";

/** What `everyApp()` keeps while it serves one request. */
export interface ServedRequest {
  request: Request;
  /** The verified user, or null on a public route. */
  user: EveryAppUser | null;
  /** When the forwarded identity expires (epoch ms); null without one. */
  expiresAt: number | null;
}

interface Scope {
  served?: ServedRequest;
  /** The organization `withOrganization()` named. */
  organizationId?: string;
}

const scopes = new AsyncLocalStorage<Scope>();

/**
 * A forwarded identity lives 120 seconds. One this close to its expiry could
 * expire before the Gateway checks it (a 401 the call can't recover from),
 * so work still running then goes on as the organization's background work.
 */
export const IDENTITY_EXPIRY_MARGIN_MS = 15_000;

/**
 * Code `request_context_missing`: `currentUser()` or a Gateway call with
 * no `for`, outside any request `everyApp()` serves and outside
 * `withOrganization()`. Work no request started names its organization.
 */
export class RequestContextError extends Error {
  readonly code = "request_context_missing";
  constructor(message: string) {
    super(message);
    this.name = "RequestContextError";
  }
}

/**
 * Code `attribution_organization_mismatch`: `withOrganization()` named
 * another organization than the request being served belongs to.
 */
export class OrganizationMismatchError extends Error {
  readonly code = "attribution_organization_mismatch";
  constructor(message: string) {
    super(message);
    this.name = "OrganizationMismatchError";
  }
}

/** Serve `fn` for one request: `everyApp()` calls this; apps don't. */
export function serveRequest<T>(served: ServedRequest, fn: () => T): T {
  return scopes.run({ served }, fn);
}

/**
 * Run `fn` as `organizationId`'s background work: every Gateway call made
 * inside it (and in what it awaits or schedules) is that organization's,
 * with no person behind it. For a Workflow step, a cron, a queue consumer or
 * a Durable Object alarm, which no request started. An organization's own
 * app names its own (`env.EVERY_APP_ORG_ID`); a shared app's Worker names
 * the one the work is for. Inside a request another organization's person
 * is driving, it throws {@link OrganizationMismatchError}; inside that
 * organization's own request, the person stays attributed while their
 * identity is good.
 */
export function withOrganization<T>(organizationId: string, fn: () => T): T {
  if (typeof organizationId !== "string" || organizationId.trim() === "") {
    throw new TypeError(
      "withOrganization(organizationId, fn) needs a non-empty organization id (an organization's own app passes env.EVERY_APP_ORG_ID).",
    );
  }
  const parent = scopes.getStore();
  const served = parent?.served;
  if (served?.user && served.user.orgId !== organizationId) {
    throw new OrganizationMismatchError(
      `withOrganization("${organizationId}") was called while serving a request of organization "${served.user.orgId}".`,
    );
  }
  return scopes.run({ ...parent, organizationId }, fn);
}

/**
 * The verified user of the request being served: an `EveryAppUser`, or
 * `null` on a public route and inside `withOrganization()`'s background
 * work. Throws {@link RequestContextError} outside both: there is no one
 * to be, and a handler that isn't under `everyApp()` is a bug.
 */
export function currentUser(): EveryAppUser | null {
  const scope = scopes.getStore();
  if (!scope) {
    throw new RequestContextError(
      "currentUser() was called outside a request everyApp() serves and outside withOrganization(): there is no user here.",
    );
  }
  return scope.served?.user ?? null;
}

/**
 * Whom a Gateway call made now is for, from the context:
 *
 *  - the request being served, while its identity is good;
 *  - else that organization's background work (the identity is about to
 *    expire, or `withOrganization()` named it);
 *  - `undefined` on a public route of an organization's own app, which the
 *    Gateway attributes to the app's organization; and
 *  - a {@link RequestContextError} outside every context.
 */
export function attributionFromContext(
  what: string,
  now: number = Date.now(),
): Request | { background: true; organizationId?: string } | undefined {
  const scope = scopes.getStore();
  if (!scope) {
    throw new RequestContextError(
      `${what} was called with no \`for\`, outside a request everyApp() serves and outside withOrganization(): the call would be nobody's. Pass for: request, or run the work under withOrganization(organizationId, fn).`,
    );
  }
  const served = scope.served;
  if (served?.user) {
    const fresh =
      served.expiresAt === null ||
      now < served.expiresAt - IDENTITY_EXPIRY_MARGIN_MS;
    // withOrganization() refused any other organization than the request's.
    if (fresh) return served.request;
    return { background: true, organizationId: served.user.orgId };
  }
  if (scope.organizationId) {
    return { background: true, organizationId: scope.organizationId };
  }
  return undefined;
}
