import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { Activity, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { EmptyState } from "@/client/components/EmptyState";
import { ErrorState } from "@/client/components/ErrorState";
import { SectionHeader } from "@/client/components/PageHeader";
import {
  UsageByAppTable,
  UsageByMemberTable,
  UsageByTargetTable,
} from "@/client/components/admin/UsageTables";
import { SetMonthlyCapModal } from "@/client/components/admin/SetMonthlyCapModal";
import { Button } from "@/client/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/client/components/ui/select";
import { monthLabel, monthOptions } from "@/client/lib/usage";
import { getUsage } from "@/serverFunctions/usage";
import type { UsageAppRow } from "@/types/usage";

export const Route = createFileRoute("/_app/admin/usage")({
  component: UsagePage,
});

function UsagePage() {
  // This UTC month and the 11 before it; the list is fixed for the visit.
  const months = useMemo(() => monthOptions(), []);
  const [month, setMonth] = useState(() => months[0]!.value);
  const isCurrentMonth = month === months[0]!.value;
  const [capApp, setCapApp] = useState<UsageAppRow | null>(null);
  const queryClient = useQueryClient();
  const onSetCap = useCallback((row: UsageAppRow) => setCapApp(row), []);

  const usageQuery = useQuery({
    queryKey: ["admin", "usage", month],
    queryFn: () => getUsage({ data: { month } }),
  });
  const summary = usageQuery.data;
  // Nothing was counted in the month: By app still lists the apps the
  // organization can call (zeros, and the cap to set), the other tables
  // would be empty. With no apps either, the empty state alone.
  const nothingCounted =
    summary !== undefined &&
    summary.byMember.length === 0 &&
    summary.byTarget.length === 0 &&
    summary.byApp.every((row) => row.calls === 0 && row.toolCalls === 0);
  const isEmpty = nothingCounted && summary.byApp.length === 0;

  const refresh = async () => {
    const result = await usageQuery.refetch();
    if (result.isError) toast.error("Failed to refresh usage");
  };

  const error = usageQuery.isError ? (
    <ErrorState
      message="Couldn't load usage."
      onRetry={() => void usageQuery.refetch()}
      isRetrying={usageQuery.isFetching}
    />
  ) : null;

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Usage"
        action={
          <div className="flex items-center gap-2">
            <Select
              items={months}
              value={month}
              onValueChange={(value) => {
                if (value !== null) setMonth(value);
              }}
            >
              <SelectTrigger aria-label="Month" className="min-w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {months.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="icon"
              aria-label="Refresh usage"
              pending={usageQuery.isFetching && !usageQuery.isLoading}
              onClick={() => void refresh()}
            >
              {usageQuery.isFetching && !usageQuery.isLoading ? null : (
                <RefreshCw />
              )}
            </Button>
          </div>
        }
      />

      {usageQuery.isError ? (
        error
      ) : isEmpty ? (
        <EmptyState
          icon={Activity}
          title={`No usage in ${monthLabel(month)}`}
        />
      ) : (
        <>
          <section className="space-y-3">
            <SectionHeader title="By app" />
            <UsageByAppTable
              rows={summary?.byApp ?? []}
              isLoading={usageQuery.isLoading}
              isCurrentMonth={isCurrentMonth}
              onSetCap={onSetCap}
            />
          </section>
          {nothingCounted ? null : (
            <>
              <section className="space-y-3">
                <SectionHeader title="By member" />
                <UsageByMemberTable
                  rows={summary?.byMember ?? []}
                  isLoading={usageQuery.isLoading}
                />
              </section>
              <section className="space-y-3">
                <SectionHeader title="By provider" />
                <UsageByTargetTable
                  rows={summary?.byTarget ?? []}
                  isLoading={usageQuery.isLoading}
                />
              </section>
            </>
          )}
        </>
      )}
      {capApp ? (
        <SetMonthlyCapModal
          app={capApp}
          isCurrentMonth={isCurrentMonth}
          onClose={() => setCapApp(null)}
          onSaved={() => {
            void queryClient.invalidateQueries({
              queryKey: ["admin", "usage"],
            });
          }}
        />
      ) : null}
    </div>
  );
}
