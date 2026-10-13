import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { useMutation, useQuery } from "@tanstack/react-query";
import { KeyRound, UserRound } from "lucide-react";
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
