import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Activity, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "@/client/components/EmptyState";
import { ErrorState } from "@/client/components/ErrorState";
import { SectionHeader } from "@/client/components/PageHeader";
import {
  UsageByAppTable,
  UsageByMemberTable,
  UsageByTargetTable,
} from "@/client/components/admin/UsageTables";
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

export const Route = createFileRoute("/_app/admin/usage")({
  component: UsagePage,
});

function UsagePage() {
  // This UTC month and the 11 before it; the list is fixed for the visit.
  const months = useMemo(() => monthOptions(), []);
  const [month, setMonth] = useState(() => months[0]!.value);

  const usageQuery = useQuery({
    queryKey: ["admin", "usage", month],
    queryFn: () => getUsage({ data: { month } }),
  });
  const summary = usageQuery.data;
  const isEmpty =
    summary !== undefined &&
    summary.byApp.length === 0 &&
    summary.byMember.length === 0 &&
    summary.byTarget.length === 0;

  const refresh = async () => {
    const result = await usageQuery.refetch();
    if (result.isError) toast.error("Failed to refresh usage");
  };

  const error = usageQuery.isError ? (
    <ErrorState
      message="Failed to load usage."
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
              <RefreshCw />
            </Button>
          </div>
        }
      />

      {isEmpty ? (
        <EmptyState
          icon={Activity}
          title={`Nothing counted in ${monthLabel(month)}`}
          description="Calls apps make through the gateway (AI providers, capabilities and agent tool calls) are counted from now on. Earlier calls were not."
        />
      ) : (
        <>
          <section className="space-y-3">
            <SectionHeader title="By app" />
            <UsageByAppTable
              rows={summary?.byApp ?? []}
              isLoading={usageQuery.isLoading}
              error={error}
            />
          </section>
          <section className="space-y-3">
            <SectionHeader title="By member" />
            <UsageByMemberTable
              rows={summary?.byMember ?? []}
              isLoading={usageQuery.isLoading}
              error={error}
            />
          </section>
          <section className="space-y-3">
            <SectionHeader title="By provider" />
            <UsageByTargetTable
              rows={summary?.byTarget ?? []}
              isLoading={usageQuery.isLoading}
              error={error}
            />
          </section>
        </>
      )}
    </div>
  );
}
