import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { useMutation, useQuery } from "@tanstack/react-query";
import { KeyRound, UserRound } from "lucide-react";
import { toast } from "sonner";
import { adminAppsCollection } from "@/client/tanstack-db";
import { queryClient } from "@/client/tanstack-db";
import { ConfirmDialog } from "@/client/components/ConfirmDialog";
import { ErrorState } from "@/client/components/ErrorState";
import { PageHeader, SectionHeader } from "@/client/components/PageHeader";
import { Button } from "@/client/components/ui/button";
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
import type { AdminAppToken } from "@/types/app-token";
import type { UserAccessToken } from "@/types/user-token";

export const Route = createFileRoute("/_app/admin/tokens")({
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
  const [revokingToken, setRevokingToken] = useState<AdminAppToken | null>(
    null,
  );
  const [revokingUserToken, setRevokingUserToken] =
    useState<UserAccessToken | null>(null);

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
      setRevokingToken(null);
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
      setRevokingUserToken(null);
    },
    onError: () => {
      toast.error("Failed to revoke personal access token");
    },
  });

  // A failure rejects, so the create dialog shows the error and stays open.
  const handleCreate = async (input: {
    tokenType: "deploy";
    expiresAt: string | null;
  }) => {
    await createTokenMutation.mutateAsync({ data: input });
    setShowCreateModal(false);
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
    <div className="h-full overflow-auto px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <PageHeader
          title="Tokens"
          description="Deploy tokens for the CLI, and personal access tokens for MCP and API clients."
        />

        <section className="space-y-3">
          <SectionHeader
            title="Deploy tokens"
            hint={
              isOwner
                ? "Create and revoke tokens that authorize the CLI to register and deploy apps."
                : "View tokens that authorize the CLI to register and deploy apps."
            }
            action={
              isOwner ? (
                <Button size="sm" onClick={() => setShowCreateModal(true)}>
                  <KeyRound data-icon="inline-start" />
                  Create deploy token
                </Button>
              ) : null
            }
          />
          <AppTokensTable
            tokens={tokensQuery.data?.tokens ?? []}
            isLoading={tokensQuery.isLoading}
            error={
              tokensQuery.isError ? (
                <ErrorState
                  message="Failed to load deploy tokens."
                  onRetry={() => void tokensQuery.refetch()}
                  isRetrying={tokensQuery.isFetching}
                />
              ) : null
            }
            onRevoke={setRevokingToken}
            isRevoking={revokeTokenMutation.isPending}
            isOwner={isOwner}
          />
        </section>

        <section className="space-y-3">
          {/* TODO: move to a member-accessible settings page (admin layout is owner/admin-gated) */}
          <SectionHeader
            title="Personal access tokens"
            hint="Bearer tokens for MCP and HTTP API clients."
            action={
              <Button
                size="sm"
                onClick={() => setShowCreateUserTokenModal(true)}
                disabled={isAppsLoading}
              >
                <UserRound data-icon="inline-start" />
                Create access token
              </Button>
            }
          />
          <UserTokensTable
            tokens={userTokensQuery.data?.tokens ?? []}
            isLoading={userTokensQuery.isLoading}
            error={
              userTokensQuery.isError ? (
                <ErrorState
                  message="Failed to load personal access tokens."
                  onRetry={() => void userTokensQuery.refetch()}
                  isRetrying={userTokensQuery.isFetching}
                />
              ) : null
            }
            onRevoke={setRevokingUserToken}
            isRevoking={revokeUserTokenMutation.isPending}
          />
        </section>

        {isOwner && showCreateModal ? (
          <CreateAppTokenModal
            onClose={() => setShowCreateModal(false)}
            onCreate={handleCreate}
          />
        ) : null}

        {revealedToken ? (
          <AppTokenRevealModal
            token={revealedToken}
            onClose={() => setRevealedToken(null)}
          />
        ) : null}

        {showCreateUserTokenModal ? (
          <CreateUserTokenModal
            onClose={() => setShowCreateUserTokenModal(false)}
            apps={apps ?? []}
            onCreate={handleCreateUserToken}
          />
        ) : null}

        {revealedUserToken ? (
          <UserTokenRevealModal
            token={revealedUserToken}
            onClose={() => setRevealedUserToken(null)}
          />
        ) : null}

        {revokingToken ? (
          <ConfirmDialog
            title={`Revoke deploy token ${revokingToken.tokenPrefix}…?`}
            confirmLabel="Revoke token"
            destructive
            pending={revokeTokenMutation.isPending}
            onClose={() => setRevokingToken(null)}
            onConfirm={() =>
              revokeTokenMutation.mutate({
                data: { tokenId: revokingToken.id },
              })
            }
          >
            Apps using it will immediately lose gateway access.
          </ConfirmDialog>
        ) : null}

        {revokingUserToken ? (
          <ConfirmDialog
            title={`Revoke “${revokingUserToken.name}”?`}
            confirmLabel="Revoke token"
            destructive
            pending={revokeUserTokenMutation.isPending}
            onClose={() => setRevokingUserToken(null)}
            onConfirm={() =>
              revokeUserTokenMutation.mutate({
                data: { tokenId: revokingUserToken.id },
              })
            }
          >
            API clients using it will immediately lose access.
          </ConfirmDialog>
        ) : null}
      </div>
    </div>
  );
}
