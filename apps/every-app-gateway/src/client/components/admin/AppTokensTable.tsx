import { useState } from "react";
import { Search } from "lucide-react";
import type { AdminAppToken } from "@/types/app-token";

interface AppTokensTableProps {
  tokens: AdminAppToken[];
  onRevoke: (tokenId: string) => Promise<void>;
  isRevoking: boolean;
}

function formatDate(date: Date | null): string {
  if (!date) return "—";
  return new Date(date).toLocaleString();
}

function statusForToken(token: AdminAppToken): {
  label: string;
  className: string;
} {
  if (token.revokedAt) {
    return { label: "Revoked", className: "badge badge-error badge-sm" };
  }

  if (token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now()) {
    return { label: "Expired", className: "badge badge-warning badge-sm" };
  }

  return { label: "Active", className: "badge badge-success badge-sm" };
}

export function AppTokensTable({
  tokens,
  onRevoke,
  isRevoking,
}: AppTokensTableProps) {
  const [searchQuery, setSearchQuery] = useState("");

  const filteredTokens = tokens.filter((token) => {
    const query = searchQuery.toLowerCase();
    return (
      token.appName.toLowerCase().includes(query) ||
      token.appSlug.toLowerCase().includes(query) ||
      token.tokenPrefix.toLowerCase().includes(query) ||
      token.scopes.join(",").toLowerCase().includes(query)
    );
  });

  if (tokens.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-base-content/70">
          No app tokens yet. Create one to allow app-to-gateway calls.
        </p>
      </div>
    );
  }

  return (
    <div>
      {tokens.length > 5 && (
        <div className="mb-4">
          <label className="input w-full max-w-xs">
            <Search className="w-4 h-4 opacity-50" />
            <input
              type="text"
              placeholder="Search tokens..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </label>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>App</th>
              <th>Prefix</th>
              <th>Scopes</th>
              <th>Status</th>
              <th>Last Used</th>
              <th>Expires</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filteredTokens.map((token) => {
              const status = statusForToken(token);
              const isRevoked = !!token.revokedAt;
              const isExpired =
                !!token.expiresAt &&
                new Date(token.expiresAt).getTime() <= Date.now();

              return (
                <tr key={token.id}>
                  <td>
                    <div className="font-medium">{token.appName}</div>
                    <div className="text-xs text-base-content/50">
                      {token.appSlug}
                    </div>
                  </td>
                  <td className="font-mono text-xs">{token.tokenPrefix}...</td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {token.scopes.map((scope) => (
                        <span
                          key={`${token.id}-${scope}`}
                          className="badge badge-ghost badge-sm"
                        >
                          {scope}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    <span className={status.className}>{status.label}</span>
                  </td>
                  <td className="text-sm">{formatDate(token.lastUsedAt)}</td>
                  <td className="text-sm">{formatDate(token.expiresAt)}</td>
                  <td>
                    <button
                      className="btn btn-xs btn-error btn-soft"
                      disabled={isRevoked || isExpired || isRevoking}
                      onClick={() => void onRevoke(token.id)}
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {filteredTokens.length === 0 && searchQuery && (
        <div className="text-center py-8">
          <p className="text-base-content/70">
            No tokens match "{searchQuery}"
          </p>
        </div>
      )}
    </div>
  );
}
