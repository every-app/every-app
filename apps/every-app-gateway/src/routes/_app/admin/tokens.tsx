import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { useMutation, useQuery } from "@tanstack/react-query";
import { UserRound } from "lucide-react";
import { toast } from "sonner";
import { adminAppsCollection } from "@/client/tanstack-db";
import { queryClient } from "@/client/tanstack-db";
import { ConfirmDialog } from "@/client/components/ConfirmDialog";
import { ErrorState } from "@/client/components/ErrorState";
import { SectionHeader } from "@/client/components/PageHeader";
import { Button } from "@/client/components/ui/button";
import { UserTokensTable } from "@/client/components/admin/UserTokensTable";
import { CreateUserTokenModal } from "@/client/components/admin/CreateUserTokenModal";
import { UserTokenRevealModal } from "@/client/components/admin/UserTokenRevealModal";
import {
  createUserToken,
  listUserTokens,
  revokeUserToken,
} from "@/serverFunctions/userTokens";
import type { UserAccessToken } from "@/types/user-token";

export const Route = createFileRoute("/_app/admin/tokens")({
  component: TokensPage,
});

function TokensPage() {
  const [showCreateUserTokenModal, setShowCreateUserTokenModal] =
    useState(false);
  const [revealedUserToken, setRevealedUserToken] = useState<string | null>(
    null,
  );
  const [revokingUserToken, setRevokingUserToken] =
    useState<UserAccessToken | null>(null);

  const { data: apps, isLoading: isAppsLoading } = useLiveQuery((q) =>
    q.from({ app: adminAppsCollection }),
  );

  const userTokensQuery = useQuery({
    queryKey: ["admin", "userTokens"],
    queryFn: () => listUserTokens(),
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
  const handleCreateUserToken = async (input: {
    name: string;
    appId?: string;
    scopes?: string[];
    expiresAt?: string;
  }) => {
    await createUserTokenMutation.mutateAsync({ data: input });
    setShowCreateUserTokenModal(false);
  };

  return (
    <div className="space-y-6">
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

      {showCreateUserTokenModal ? (
        <CreateUserTokenModal
          onClose={() => setShowCreateUserTokenModal(false)}
          apps={apps ?? []}
          allowDeployKeys={userTokensQuery.data?.deployKeys ?? false}
          onCreate={handleCreateUserToken}
        />
      ) : null}

      {revealedUserToken ? (
        <UserTokenRevealModal
          token={revealedUserToken}
          onClose={() => setRevealedUserToken(null)}
        />
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
  );
}
