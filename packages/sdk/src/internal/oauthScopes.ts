/**
 * Scopes for an OAuth provider the Gateway runs the flow for: what a
 * connect asks for, what a token response says it granted, whether that
 * is more than was asked, and whether a connection holds what an app
 * declares. One set of rules for every provider, driven by its spec
 * (./oauthSpec.ts): the separator, the prefix, the identity scopes and
 * the tolerated ones. Nothing here names a provider, reads a secret or a
 * token value.
 *
 * An app's `everyapp.config.ts` lists the provider's own scope strings,
 * short (`gmail.modify`, joined onto the spec's `scopePrefix`) or in
 * full. Comparison is of the canonical form: percent-decoded, lower case,
 * the prefix taken off.
 */
import type { OAuthFlow } from "./capabilities.js";

/** The scope rules of a provider's flow. */
type ScopeRules = Pick<
  OAuthFlow,
  "scopeSeparator" | "scopePrefix" | "identityScopes" | "tolerated"
>;

/**
 * A scope as the provider is asked for it: an app's short scope joined
 * onto the spec's prefix; a full one (with `://`), one of the spec's own
 * identity or tolerated scopes, or any scope of a provider without a
 * prefix, as written.
 */
export function expandScope(rules: ScopeRules, scope: string): string {
  const prefix = rules.scopePrefix;
  if (!prefix || scope.includes("://")) return scope;
  const own = [...rules.identityScopes, ...rules.tolerated];
  return own.includes(scope) ? scope : `${prefix}${scope}`;
}

/** A scope in the one spelling comparisons use: decoded, lower case, without the prefix. */
export function canonicalScope(rules: ScopeRules, scope: string): string {
  let text = scope.trim();
  if (text.includes("%")) {
    try {
      text = decodeURIComponent(text);
    } catch {
      // A malformed escape stays as written, and matches nothing asked.
    }
  }
  text = text.toLowerCase();
  const prefix = rules.scopePrefix?.toLowerCase();
  return prefix && text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

/** `scopes` canonical, deduplicated, order kept. */
export function canonicalScopes(
  rules: ScopeRules,
  scopes: readonly string[],
): string[] {
  const out: string[] = [];
  for (const scope of scopes) {
    const canonical = canonicalScope(rules, scope);
    if (canonical && !out.includes(canonical)) out.push(canonical);
  }
  return out;
}

/**
 * What a connect for an app that declares `declared` asks the provider
 * for, in the provider's spelling: the app's scopes, then the spec's
 * identity scopes, each once.
 */
export function requestedScopes(
  rules: ScopeRules,
  declared: readonly string[],
): string[] {
  const out: string[] = [];
  for (const scope of [
    ...declared.map((each) => expandScope(rules, each)),
    ...rules.identityScopes,
  ]) {
    if (!out.includes(scope)) out.push(scope);
  }
  return out;
}

/** Scopes joined as the provider's `scope` parameter takes them. */
export function joinScopes(
  rules: Pick<OAuthFlow, "scopeSeparator">,
  scopes: readonly string[],
): string {
  return scopes.join(rules.scopeSeparator === "comma" ? "," : " ");
}

/**
 * The scopes a token response says it granted, canonical. A response
 * with no `scope` field is taken as granted exactly as `requested` (RFC
 * 6749 §5.1); one whose `scope` isn't a string is null (refused).
 */
export function grantedScopes(
  rules: ScopeRules,
  body: Record<string, unknown>,
  requested: readonly string[],
): string[] | null {
  const raw = body["scope"];
  if (raw === undefined) return canonicalScopes(rules, requested);
  if (typeof raw !== "string") return null;
  let text = raw;
  if (text.includes("%")) {
    try {
      text = decodeURIComponent(text);
    } catch {
      return null;
    }
  }
  const split =
    rules.scopeSeparator === "comma" ? text.split(/[,\s]+/) : text.split(/\s+/);
  return canonicalScopes(rules, split.filter(Boolean));
}

/**
 * The mint check: what `granted` (canonical) carries beyond `requested`,
 * the identity scopes and the tolerated ones. Empty means the token may
 * be kept; anything else and the Gateway drops it.
 */
export function scopeExcess(
  rules: ScopeRules,
  granted: readonly string[],
  requested: readonly string[],
): string[] {
  const allowed = canonicalScopes(rules, [
    ...requested,
    ...rules.identityScopes,
    ...rules.tolerated,
  ]);
  return granted.filter((scope) => !allowed.includes(scope));
}

/**
 * The scopes an app declares that a connection doesn't hold: `held` is
 * the connection's canonical list, `declared` as the app wrote them.
 */
export function missingScopes(
  rules: ScopeRules,
  held: readonly string[],
  declared: readonly string[],
): string[] {
  const have = canonicalScopes(rules, held);
  return declared.filter(
    (scope) => !have.includes(canonicalScope(rules, scope)),
  );
}

/**
 * `text` as a JSON object, or null for anything else (an array, a scalar,
 * not JSON). The gateway's read of a provider's token answer.
 */
export function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
