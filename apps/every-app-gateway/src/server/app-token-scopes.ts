const PROVIDER_SCOPE_PREFIX = "provider:";
const DEPLOY_TOKEN_SCOPES = new Set(["apps:register", "apps:deploy"]);

export function normalizeTokenScope(scope: string): string | null {
  const normalized = scope.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (DEPLOY_TOKEN_SCOPES.has(normalized)) {
    return normalized;
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
