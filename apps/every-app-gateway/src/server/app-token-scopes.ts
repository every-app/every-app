const PROVIDER_SCOPE_PREFIX = "provider:";
const PROVIDER_SCOPE_WILDCARD = "provider:*";
const LEGACY_PROVIDER_SCOPE_WILDCARD = "providers:*";

export function normalizeProviderName(provider: string): string {
  return provider.trim().toLowerCase();
}

export function normalizeTokenScope(scope: string): string | null {
  const normalized = scope.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (
    normalized === PROVIDER_SCOPE_WILDCARD ||
    normalized === LEGACY_PROVIDER_SCOPE_WILDCARD
  ) {
    return PROVIDER_SCOPE_WILDCARD;
  }

  if (!normalized.startsWith(PROVIDER_SCOPE_PREFIX)) {
    return null;
  }

  const providerName = normalized.slice(PROVIDER_SCOPE_PREFIX.length).trim();
  if (!providerName || providerName.includes("*")) {
    return null;
  }

  if (!/^[a-z0-9-]+$/.test(providerName)) {
    return null;
  }

  return `${PROVIDER_SCOPE_PREFIX}${providerName}`;
}

export function normalizeTokenScopes(scopes: string[]): string[] {
  const normalizedScopes = scopes
    .map((scope) => normalizeTokenScope(scope))
    .filter((scope): scope is string => scope !== null);

  return [...new Set(normalizedScopes)];
}

export function hasProviderScope(scopes: string[], provider: string): boolean {
  const normalizedProvider = normalizeProviderName(provider);
  if (!normalizedProvider) {
    return false;
  }

  const normalizedScopes = new Set(normalizeTokenScopes(scopes));
  return (
    normalizedScopes.has(PROVIDER_SCOPE_WILDCARD) ||
    normalizedScopes.has(`${PROVIDER_SCOPE_PREFIX}${normalizedProvider}`)
  );
}
