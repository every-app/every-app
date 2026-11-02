import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ConfirmDialog } from "@/client/components/ConfirmDialog";
import { ErrorState } from "@/client/components/ErrorState";
import { SectionHeader } from "@/client/components/PageHeader";
import { DateCell } from "@/client/components/table/DateCell";
import { Button } from "@/client/components/ui/button";
import { Skeleton } from "@/client/components/ui/skeleton";
import { getRuleErrorMessage } from "@/client/errors";
import {
  listAllBackgroundGrants,
  listMyBackgroundGrants,
  revokeBackgroundGrant,
} from "@/serverFunctions/connections";

type Grant = Awaited<
  ReturnType<typeof listMyBackgroundGrants>
>["grants"][number];

/**
 * The apps allowed to use a connection while nobody has them open
 * (docs/design/2026-11-birds-decisions/888-background-oauth.md), each
 * with Revoke: the person's own under Settings → Connected accounts, every
 * member's under Manage workspace → Providers (`admin`).
 */
export function BackgroundGrants({ admin = false }: { admin?: boolean }) {
  const queryClient = useQueryClient();
  const key = ["backgroundGrants", admin ? "all" : "mine"] as const;
  const [revoking, setRevoking] = useState<Grant | null>(null);
  const query = useQuery({
    queryKey: key,
    queryFn: () =>
      admin ? listAllBackgroundGrants() : listMyBackgroundGrants(),
  });
  const revoke = useMutation({
    mutationFn: revokeBackgroundGrant,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["backgroundGrants"] });
      toast.success("Background use revoked");
    },
    onError: (error) =>
      toast.error(getRuleErrorMessage(error, "Failed to revoke")),
  });
  const grants = query.data?.grants ?? [];
  if (!admin && !query.isLoading && !query.isError && grants.length === 0) {
    return null;
  }
  return (
    <section className="space-y-3" aria-label="Background use">
      <SectionHeader
        title="Background use"
        hint={
          admin
            ? "Apps members let use their own connection while they're away. Revoking stops it at once and is in the audit log."
            : "Apps you let use your accounts while you're away. It stops if you revoke it, or after 90 days in which you don't open the app."
        }
      />
      {query.isError ? (
        <ErrorState
          message="Couldn't load background use."
          onRetry={() => void query.refetch()}
          isRetrying={query.isFetching}
        />
      ) : query.isLoading ? (
        <Skeleton className="h-14 w-full" />
      ) : grants.length === 0 ? (
        <p className="rounded-lg border border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No app uses a member's connection in the background.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {grants.map((grant) => (
            <li
              key={grant.id}
              className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 space-y-0.5">
                <p className="text-sm font-medium">
                  {grant.app.name} can use{" "}
                  {admin
                    ? `${grant.user.name ?? grant.user.email ?? "a member"}'s`
                    : "this"}{" "}
                  {grant.providerName}
                  {grant.connectionLabel
                    ? ` (${grant.connectionLabel})`
                    : ""}{" "}
                  in the background
                </p>
                <p className="text-xs text-muted-foreground">
                  {grant.scopeSets.join(", ")} · last used{" "}
                  <DateCell value={grant.lastUsedAt} fallback="never" /> ·
                  lapses <DateCell value={grant.lapsesAt} /> unless the app is
                  opened
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setRevoking(grant)}
                aria-label={`Revoke ${grant.app.name}'s background use of ${grant.providerName}`}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
      {revoking ? (
        <ConfirmDialog
          title={`Revoke ${revoking.app.name}'s background use?`}
          confirmLabel="Revoke"
          destructive
          pending={revoke.isPending}
          onClose={() => setRevoking(null)}
          onConfirm={() =>
            revoke.mutate(
              { data: { grantId: revoking.id } },
              { onSettled: () => setRevoking(null) },
            )
          }
        >
          {revoking.app.name} stops using {revoking.providerName} while nobody
          has it open. It still works while{" "}
          {admin ? "the member uses" : "you use"} it.
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
