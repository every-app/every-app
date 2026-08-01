import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { useMutation, useQuery } from "@tanstack/react-query";
import { KeyRound, PlugZap, UserRound } from "lucide-react";
import { toast } from "sonner";
import { adminAppsCollection } from "@/client/tanstack-db";
import { queryClient } from "@/client/tanstack-db";
import { AppTokensTable } from "@/client/components/admin/AppTokensTable";
import { CreateAppTokenModal } from "@/client/components/admin/CreateAppTokenModal";
import { AppTokenRevealModal } from "@/client/components/admin/AppTokenRevealModal";
import { UserTokensTable } from "@/client/components/admin/UserTokensTable";
import { CreateUserTokenModal } from "@/client/components/admin/CreateUserTokenModal";
import { UserTokenRevealModal } from "@/client/components/admin/UserTokenRevealModal";
import {
  createAppToken,
  listAppTokens,
  revokeAppToken,
} from "@/serverFunctions/appTokens";
import {
  createUserToken,
  listUserTokens,
  revokeUserToken,
} from "@/serverFunctions/userTokens";
import {
  listMyOauthGrants,
  revokeMyOauthGrant,
} from "@/serverFunctions/oauthGrants";
import { authClient } from "@/client/auth-client";

export const Route = createFileRoute("/admin/tokens")({
  component: TokensPage,
});

function TokensPage() {
  const { data: activeMemberRole } = authClient.useActiveMemberRole();
  const isOwner = activeMemberRole?.role === "owner";
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showCreateUserTokenModal, setShowCreateUserTokenModal] =
    useState(false);
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [revealedUserToken, setRevealedUserToken] = useState<string | null>(
    null,
  );

  const { data: apps, isLoading: isAppsLoading } = useLiveQuery((q) =>
    q.from({ app: adminAppsCollection }),
  );

  const tokensQuery = useQuery({
    queryKey: ["admin", "appTokens"],
    queryFn: () => listAppTokens(),
  });

  const userTokensQuery = useQuery({
    queryKey: ["admin", "userTokens"],
    queryFn: () => listUserTokens(),
  });

  const oauthGrantsQuery = useQuery({
    queryKey: ["admin", "oauthGrants"],
    queryFn: () => listMyOauthGrants(),
  });

  const createTokenMutation = useMutation({
    mutationFn: createAppToken,
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ["admin", "appTokens"] });
      setRevealedToken(data.token);
    },
  });

  const revokeTokenMutation = useMutation({
    mutationFn: revokeAppToken,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["admin", "appTokens"] });
      toast.success("Token revoked");
    },
    onError: () => {
      toast.error("Failed to revoke token");
    },
  });

  const createUserTokenMutation = useMutation({
    mutationFn: createUserToken,
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({
        queryKey: ["admin", "userTokens"],
      });
      setRevealedUserToken(data.plaintext);
    },
  });

  const revokeUserTokenMutation = useMutation({
    mutationFn: revokeUserToken,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["admin", "userTokens"],
      });
      toast.success("Personal access token revoked");
    },
    onError: () => {
      toast.error("Failed to revoke personal access token");
    },
  });

  const revokeOauthGrantMutation = useMutation({
    mutationFn: revokeMyOauthGrant,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["admin", "oauthGrants"],
      });
      toast.success("Connected app revoked");
    },
    onError: () => {
      toast.error("Failed to revoke connected app");
    },
  });

  const handleRevoke = async (tokenId: string) => {
    const confirmed = window.confirm(
      "Revoke this token? Apps using it will immediately lose gateway access.",
    );
    if (!confirmed) return;

    await revokeTokenMutation.mutateAsync({ data: { tokenId } });
  };

  const handleCreate = async (input: {
    tokenType: "deploy";
    expiresAt: string | null;
  }) => {
    try {
      await createTokenMutation.mutateAsync({ data: input });
      setShowCreateModal(false);
    } catch (err) {
      throw err;
    }
  };

  const handleRevokeUserToken = async (tokenId: string) => {
    const confirmed = window.confirm(
      "Revoke this personal access token? API clients using it will immediately lose access.",
    );
    if (!confirmed) return;

    await revokeUserTokenMutation.mutateAsync({ data: { tokenId } });
  };

  const handleCreateUserToken = async (input: {
    name: string;
    appId?: string;
    expiresAt?: string;
  }) => {
    await createUserTokenMutation.mutateAsync({ data: input });
    setShowCreateUserTokenModal(false);
  };

  const handleRevokeOauthGrant = async (grantId: string) => {
    const confirmed = window.confirm(
      "Revoke this connected app? Its OAuth tokens will stop working.",
    );
    if (!confirmed) return;

    await revokeOauthGrantMutation.mutateAsync({ data: { grantId } });
  };

  return (
    <div className="w-full space-y-10">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold">Deploy tokens</h1>
          <p className="text-base-content/70 mt-1">
            {isOwner
              ? "Create and revoke tokens that authorize the CLI to register and deploy apps."
              : "View tokens that authorize the CLI to register and deploy apps."}
          </p>
        </div>
        {isOwner && (
          <button
            className="btn btn-primary"
            onClick={() => setShowCreateModal(true)}
          >
            <KeyRound className="w-4 h-4 mr-2" />
            Create Deploy Token
          </button>
        )}
      </div>

      {tokensQuery.isError && (
        <div className="alert alert-error">
          <span>Failed to load tokens. Please try again.</span>
        </div>
      )}

      {tokensQuery.isLoading ? (
        <div className="flex justify-center py-12">
          <span className="loading loading-spinner loading-lg"></span>
        </div>
      ) : (
        <AppTokensTable
          tokens={tokensQuery.data?.tokens ?? []}
          onRevoke={handleRevoke}
          isRevoking={revokeTokenMutation.isPending}
          isOwner={isOwner}
        />
      )}

      {isOwner && (
        <CreateAppTokenModal
          open={showCreateModal}
          onClose={() => setShowCreateModal(false)}
          onCreate={handleCreate}
        />
      )}

      <AppTokenRevealModal
        open={!!revealedToken}
        onClose={() => {
          setRevealedToken(null);
        }}
        token={revealedToken}
      />

      <section>
        {/* TODO: move to a member-accessible settings page (admin layout is owner/admin-gated) */}
        <div className="flex justify-between items-center mb-6">
          <div>
            <h2 className="text-xl font-bold">Personal access tokens</h2>
            <p className="text-base-content/70 mt-1">
              Bearer tokens for MCP and HTTP API clients.
            </p>
          </div>
          <button
            className="btn btn-primary"
            onClick={() => setShowCreateUserTokenModal(true)}
            disabled={isAppsLoading}
          >
            <UserRound className="w-4 h-4 mr-2" />
            Create PAT
          </button>
        </div>

        {userTokensQuery.isError && (
          <div className="alert alert-error">
            <span>Failed to load personal access tokens.</span>
          </div>
        )}

        {userTokensQuery.isLoading ? (
          <div className="flex justify-center py-12">
            <span className="loading loading-spinner loading-lg"></span>
          </div>
        ) : (
          <UserTokensTable
            tokens={userTokensQuery.data?.tokens ?? []}
            onRevoke={handleRevokeUserToken}
            isRevoking={revokeUserTokenMutation.isPending}
          />
        )}
      </section>

      <section>
        <div className="flex justify-between items-center mb-6">
          <div>
            <h2 className="text-xl font-bold">Connected apps</h2>
            <p className="text-base-content/70 mt-1">
              OAuth clients authorized to access your apps.
            </p>
          </div>
          <PlugZap className="w-5 h-5 text-base-content/50" />
        </div>

        {oauthGrantsQuery.isError && (
          <div className="alert alert-error">
            <span>Failed to load connected apps.</span>
          </div>
        )}

        {oauthGrantsQuery.isLoading ? (
          <div className="flex justify-center py-12">
            <span className="loading loading-spinner loading-lg"></span>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>App</th>
                  <th>Scopes</th>
                  <th>Granted</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {(oauthGrantsQuery.data?.grants ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={5} className="text-center py-8 opacity-60">
                      No connected apps.
                    </td>
                  </tr>
                ) : (
                  oauthGrantsQuery.data?.grants.map((grant) => (
                    <tr key={grant.id}>
                      <td>
                        <div className="font-medium">{grant.clientName}</div>
                        <div className="text-xs opacity-60">
                          {grant.clientId}
                        </div>
                      </td>
                      <td>{grant.appName}</td>
                      <td>
                        <div className="flex flex-wrap gap-1">
                          {grant.scopes.map((scope) => (
                            <span key={scope} className="badge badge-outline">
                              {scope === "*" ? "Full access" : scope}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td>{new Date(grant.createdAt).toLocaleDateString()}</td>
                      <td className="text-right">
                        <button
                          className="btn btn-sm btn-error btn-outline"
                          onClick={() => handleRevokeOauthGrant(grant.id)}
                          disabled={revokeOauthGrantMutation.isPending}
                        >
                          Revoke
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <CreateUserTokenModal
        open={showCreateUserTokenModal}
        onClose={() => setShowCreateUserTokenModal(false)}
        apps={apps ?? []}
        onCreate={handleCreateUserToken}
      />

      <UserTokenRevealModal
        open={!!revealedUserToken}
        onClose={() => setRevealedUserToken(null)}
        token={revealedUserToken}
      />
    </div>
  );
}
