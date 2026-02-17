import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { useMutation, useQuery } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { toast } from "sonner";
import { adminAppsCollection } from "@/client/tanstack-db";
import { queryClient } from "@/client/tanstack-db";
import { AppTokensTable } from "@/client/components/admin/AppTokensTable";
import { CreateAppTokenModal } from "@/client/components/admin/CreateAppTokenModal";
import { AppTokenRevealModal } from "@/client/components/admin/AppTokenRevealModal";
import {
  createAppToken,
  listAppTokens,
  revokeAppToken,
} from "@/serverFunctions/appTokens";

export const Route = createFileRoute("/admin/tokens")({
  component: TokensPage,
});

function TokensPage() {
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [revealedTokenAppName, setRevealedTokenAppName] = useState("");

  const { data: apps, isLoading: isAppsLoading } = useLiveQuery((q) =>
    q.from({ app: adminAppsCollection }),
  );

  const tokensQuery = useQuery({
    queryKey: ["admin", "appTokens"],
    queryFn: () => listAppTokens(),
  });

  const createTokenMutation = useMutation({
    mutationFn: createAppToken,
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ["admin", "appTokens"] });
      setRevealedToken(data.token);
      setRevealedTokenAppName(data.appName);
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

  const handleRevoke = async (tokenId: string) => {
    const confirmed = window.confirm(
      "Revoke this token? Apps using it will immediately lose gateway access.",
    );
    if (!confirmed) return;

    await revokeTokenMutation.mutateAsync({ data: { tokenId } });
  };

  const handleCreate = async (input: {
    appId: string;
    scopes: string[];
    expiresAt: string | null;
  }) => {
    try {
      await createTokenMutation.mutateAsync({ data: input });
      setShowCreateModal(false);
    } catch (err) {
      throw err instanceof Error ? err : new Error("Failed to create token");
    }
  };

  return (
    <div className="w-full">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold">App Tokens</h1>
          <p className="text-base-content/70 mt-1">
            Create and revoke machine tokens for app-to-gateway requests.
          </p>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => setShowCreateModal(true)}
          disabled={isAppsLoading || (apps?.length ?? 0) === 0}
        >
          <KeyRound className="w-4 h-4 mr-2" />
          Create Token
        </button>
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
        />
      )}

      <CreateAppTokenModal
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        apps={apps ?? []}
        onCreate={handleCreate}
      />

      <AppTokenRevealModal
        open={!!revealedToken}
        onClose={() => {
          setRevealedToken(null);
          setRevealedTokenAppName("");
        }}
        token={revealedToken}
        appName={revealedTokenAppName}
      />
    </div>
  );
}
