/**
 * Public-route matching for the gateway perimeter.
 *
 * The security rule is "default-private, deny on ambiguity": a request is only
 * treated as public if (a) its path canonicalizes unambiguously and (b) the
 * canonical path matches a declared, safe public glob. Anything weird about the
 * encoding (double-encoding, encoded separators, traversal, control bytes)
 * makes the path ambiguous, and ambiguous paths are never public.
 *
 * Crucially, the `/__everyapp/*` internal namespace is denied *after*
 * normalization, so tricks like `/p/%2e%2e/__everyapp/tools/call` cannot smuggle
 * a request onto an internal route via a public glob.
 */
import { TOOLS_PATH_PREFIX } from "@every-app/sdk/internal";
import {
  EVERYAPP_INTERNAL_PREFIX,
  type PublicRoute,
} from "./manifest/manifest";

export interface NormalizedPath {
  /** The canonical, fully-resolved path (leading slash, no `.`/`..`, no `//`). */
  canonical: string;
  /**
   * True when the raw path could not be canonicalized with confidence. Ambiguous
   * paths are always denied (never public) and never matched against globs.
   */
  ambiguous: boolean;
  /** Human-readable reason, for logging/tests. */
  reason?: string;
}

const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
// Encoded path separators / backslash. Decoding these would change the segment
// structure after the fact, so their presence is treated as ambiguous.
const ENCODED_SEPARATOR = /%2f|%5c/i;

/**
 * Canonicalize a raw URL pathname for matching. Operates on the `%`-encoded
 * form exactly as it arrived (e.g. `url.pathname`).
 */
export function normalizePath(rawPathname: string): NormalizedPath {
  if (typeof rawPathname !== "string" || rawPathname.length === 0) {
    return { canonical: "/", ambiguous: true, reason: "empty path" };
  }
  if (!rawPathname.startsWith("/")) {
    return { canonical: "/", ambiguous: true, reason: "non-absolute path" };
  }
  if (CONTROL_CHARS.test(rawPathname)) {
    return { canonical: "/", ambiguous: true, reason: "control characters" };
  }
  if (rawPathname.includes("\\")) {
    return { canonical: "/", ambiguous: true, reason: "backslash" };
  }
  if (ENCODED_SEPARATOR.test(rawPathname)) {
    return {
      canonical: "/",
      ambiguous: true,
      reason: "encoded path separator",
    };
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPathname);
  } catch {
    return {
      canonical: "/",
      ambiguous: true,
      reason: "invalid percent-encoding",
    };
  }
  // Anything still percent-shaped after one decode is double-encoded.
  if (decoded.includes("%")) {
    return { canonical: "/", ambiguous: true, reason: "double-encoded" };
  }
  // Decoding must not have introduced new separators or control bytes.
  if (CONTROL_CHARS.test(decoded) || decoded.includes("\\")) {
    return {
      canonical: "/",
      ambiguous: true,
      reason: "decoded to unsafe characters",
    };
  }

  // Resolve `.` and `..` segments. A `..` that escapes the root is hostile.
  const out: string[] = [];
  let traversed = false;
  for (const segment of decoded.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) {
        return {
          canonical: "/",
          ambiguous: true,
          reason: "path traversal above root",
        };
      }
      out.pop();
      traversed = true;
      continue;
    }
    out.push(segment);
  }
  const canonical = "/" + out.join("/");

  // If the raw form contained encoded dots used for traversal, the request is
  // trying to hide its true target — canonicalize but flag ambiguous so it can
  // never be treated as public.
  if (traversed && /%2e/i.test(rawPathname)) {
    return { canonical, ambiguous: true, reason: "encoded traversal" };
  }
  return { canonical, ambiguous: false };
}

/** True if the canonical path is inside the reserved internal namespace. */
export function isInternalPath(canonical: string): boolean {
  return (
    canonical === EVERYAPP_INTERNAL_PREFIX ||
    canonical.startsWith(EVERYAPP_INTERNAL_PREFIX + "/")
  );
}

/**
 * True when a raw request path reaches the internal tools contract
 * (`/__everyapp/tools/*`) under any spelling: canonical, dot segments,
 * encoded separators, double encoding or case. Only the gateway's ToolBus
 * calls it, over the service binding, so external requests are refused.
 */
export function isReservedToolsPath(rawPathname: string): boolean {
  return (
    isToolsNamespace(normalizePath(rawPathname).canonical) ||
    // Ambiguous encodings normalize to "/"; look through them as well.
    isToolsNamespace(looselyCanonical(rawPathname))
  );
}

function isToolsNamespace(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower === TOOLS_PATH_PREFIX || lower.startsWith(`${TOOLS_PATH_PREFIX}/`)
  );
}

/**
 * The OAuth discovery documents an app host must never serve. An app host is
 * no OAuth resource (the gateway's own /mcp is the only one), so RFC 9728
 * protected-resource metadata is reserved; and an MCP client that finds none
 * falls back (2025-03-26 spec) to the RFC 8414 and OpenID discovery documents
 * at the MCP server's origin, so an app must not be able to publish one that
 * names an attacker's authorization endpoint for its /mcp. Each prefix also
 * covers the path-suffixed forms (`.../oauth-authorization-server/mcp`).
 */
const RESERVED_DISCOVERY_DOCUMENTS = [
  "oauth-protected-resource",
  "oauth-authorization-server",
  "openid-configuration",
];

const RESERVED_WELL_KNOWN_PREFIXES = RESERVED_DISCOVERY_DOCUMENTS.flatMap(
  (name) => [
    `/.well-known/${name}`,
    // The MCP SDK's last fallback appends OpenID discovery after the MCP
    // server's path (`/mcp/.well-known/openid-configuration`), which a public
    // `/mcp/**` route would otherwise proxy; reserve that shape as well.
    `/mcp/.well-known/${name}`,
  ],
);

/**
 * True when a raw request path reaches one of the reserved OAuth discovery
 * documents under any spelling, resolved the same fail-closed way as
 * {@link isReservedToolsPath}: a manifest's public `/.well-known/*` or
 * `/mcp/**` route never reaches these, and the gateway answers 404 for them
 * without proxying.
 */
export function isReservedWellKnownPath(rawPathname: string): boolean {
  return (
    isReservedWellKnown(normalizePath(rawPathname).canonical) ||
    // Ambiguous encodings normalize to "/"; look through them as well.
    isReservedWellKnown(looselyCanonical(rawPathname))
  );
}

function isReservedWellKnown(path: string): boolean {
  const lower = path.toLowerCase();
  return RESERVED_WELL_KNOWN_PREFIXES.some(
    (prefix) => lower === prefix || lower.startsWith(`${prefix}/`),
  );
}

/** Decode repeatedly, treat backslashes as separators, resolve dot segments. */
function looselyCanonical(rawPathname: string): string {
  let decoded = rawPathname;
  for (let round = 0; round < 3; round += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      break;
    }
    if (next === decoded) break;
    decoded = next;
  }
  const out: string[] = [];
  for (const segment of decoded.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return "/" + out.join("/");
}

/** Compile a single glob path into an anchored RegExp. */
function globToRegExp(glob: string): RegExp {
  // Split on `*` runs so we can distinguish `*` (single segment) from `**`.
  let re = "^";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        re += ".*"; // `**` — across segments
        i += 2;
      } else {
        re += "[^/]*"; // `*` — within a segment
        i += 1;
      }
    } else if (ch === ":" && glob[i - 1] === "/") {
      const name = glob.slice(i + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0];
      const next = name ? glob[i + 1 + name.length] : undefined;
      if (name && (next === undefined || next === "/")) {
        re += "[^/]+"; // `:name` — exactly one non-empty segment
        i += 1 + name.length;
      } else {
        re += "\\:";
        i += 1;
      }
    } else {
      re += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  re += "$";
  return new RegExp(re);
}

export interface PublicMatch {
  public: boolean;
  route?: PublicRoute;
  reason: string;
}

/**
 * Decide whether a request is public. Default-deny. The method check is
 * case-insensitive; methods default to GET-only.
 */
export function matchPublicRoute(
  routes: PublicRoute[] | undefined,
  method: string,
  rawPathname: string,
): PublicMatch {
  if (!routes || routes.length === 0) {
    return { public: false, reason: "no public routes declared" };
  }
  const { canonical, ambiguous, reason } = normalizePath(rawPathname);
  if (ambiguous) {
    return { public: false, reason: `ambiguous path: ${reason}` };
  }
  // Internal namespace is denied post-normalization, unconditionally.
  if (isInternalPath(canonical)) {
    return { public: false, reason: "internal namespace is never public" };
  }
  const upperMethod = method.toUpperCase();
  for (const route of routes) {
    const allowed = (route.methods ?? ["GET"]).map((m) => m.toUpperCase());
    if (!allowed.includes(upperMethod)) continue;
    if (globToRegExp(route.path).test(canonical)) {
      return { public: true, route, reason: `matched ${route.path}` };
    }
  }
  return { public: false, reason: "no matching public route" };
}

/**
 * Decide whether a request is on a bearer route (`bearerRoutes`): a path
 * a native client reaches with a bearer token only, matched on every
 * method with the same canonicalization, glob syntax and internal-namespace
 * denial as {@link matchPublicRoute}. The gateway refuses its session
 * cookie there and never serves the path anonymously, whatever `public`
 * says (the manifest refuses a path listed under both).
 */
export function matchBearerRoute(
  globs: readonly string[] | undefined,
  method: string,
  rawPathname: string,
): PublicMatch {
  if (!globs || globs.length === 0) {
    return { public: false, reason: "no bearer routes declared" };
  }
  return matchPublicRoute(
    globs.map((path) => ({ path, methods: [method] })),
    method,
    rawPathname,
  );
}

/** RFC 9728: where an app host's protected-resource metadata lives. */
export const PROTECTED_RESOURCE_METADATA_PATH =
  "/.well-known/oauth-protected-resource";

/**
 * True for exactly the protected-resource metadata path (RFC 9728 §3 for a
 * resource whose URL has no path), spelled canonically: the one reserved
 * discovery document the gateway writes itself on an app host. Any other
 * spelling, and every other reserved document, stays a 404
 * ({@link isReservedWellKnownPath}).
 */
export function isProtectedResourceMetadataPath(rawPathname: string): boolean {
  const { canonical, ambiguous } = normalizePath(rawPathname);
  return !ambiguous && canonical === PROTECTED_RESOURCE_METADATA_PATH;
}

/** The methods a public asset answers: the Workers asset server's own. */
export const PUBLIC_ASSET_METHODS = ["GET", "HEAD"] as const;

/** True for `/mcp` and anything under it, which is never a public asset. */
export function isMcpPath(canonical: string): boolean {
  return canonical === "/mcp" || canonical.startsWith("/mcp/");
}

/**
 * Decide whether a request is for a public static file (`publicAssets`):
 * a GET or HEAD whose canonical path matches one of the globs, matched with
 * the same canonicalization, glob syntax and internal-namespace denial as
 * {@link matchPublicRoute}. `/mcp` and anything under it never match (the
 * manifest refuses such a glob at author time; this also covers a stored
 * row). The gateway forwards a match with no identity and no public marker,
 * so only the asset server can answer it with content: the app's Worker,
 * behind `everyApp()`, refuses a request carrying neither.
 */
export function matchPublicAsset(
  globs: readonly string[] | undefined,
  method: string,
  rawPathname: string,
): PublicMatch {
  if (!globs || globs.length === 0) {
    return { public: false, reason: "no public assets declared" };
  }
  const match = matchPublicRoute(
    globs.map((path) => ({ path, methods: [...PUBLIC_ASSET_METHODS] })),
    method,
    rawPathname,
  );
  if (!match.public) return match;
  if (isMcpPath(normalizePath(rawPathname).canonical)) {
    return { public: false, reason: "/mcp is never a public asset" };
  }
  return match;
}
