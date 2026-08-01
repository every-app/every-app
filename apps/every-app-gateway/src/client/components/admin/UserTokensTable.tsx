import type { UserAccessToken } from "@/types/user-token";

interface UserTokensTableProps {
  tokens: UserAccessToken[];
  onRevoke: (tokenId: string) => Promise<void>;
  isRevoking: boolean;
}

function formatDate(date: Date | null): string {
  if (!date) return "-";
  return new Date(date).toLocaleString();
}

function appScopeLabel(token: UserAccessToken): string {
  return token.appName ? `${token.appName} (${token.appSlug})` : "all my apps";
}

export function UserTokensTable({
  tokens,
  onRevoke,
  isRevoking,
}: UserTokensTableProps) {
  if (tokens.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-base-content/70">No personal access tokens yet.</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Prefix</th>
            <th>App Scope</th>
            <th>Created</th>
            <th>Expires</th>
            <th>Last Used</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {tokens.map((token) => {
            const isRevoked = !!token.revokedAt;
            const isExpired = new Date(token.expiresAt).getTime() <= Date.now();

            return (
              <tr key={token.id}>
                <td>
                  <div className="font-medium">{token.name}</div>
                  {(isRevoked || isExpired) && (
                    <div className="badge badge-ghost badge-sm mt-1">
                      {isRevoked ? "revoked" : "expired"}
                    </div>
                  )}
                </td>
                <td className="font-mono text-xs">{token.tokenPrefix}...</td>
                <td className="text-sm">{appScopeLabel(token)}</td>
                <td className="text-sm">{formatDate(token.createdAt)}</td>
                <td className="text-sm">{formatDate(token.expiresAt)}</td>
                <td className="text-sm">{formatDate(token.lastUsedAt)}</td>
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
  );
}
