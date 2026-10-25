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
  UsageByModelTable,
  UsageByTargetTable,
} from "@/client/components/admin/UsageTables";
import { AiDefaultCard } from "@/client/components/admin/AiDefaultCard";
import { SetAiDefaultModal } from "@/client/components/admin/SetAiDefaultModal";
import { SetDefaultCapModal } from "@/client/components/admin/SetDefaultCapModal";
import { SetMonthlyCapModal } from "@/client/components/admin/SetMonthlyCapModal";
import { Button } from "@/client/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/client/components/ui/select";
import {
  formatCostCap,
  formatCount,
  monthLabel,
  monthOptions,
} from "@/client/lib/usage";
import { getAiDefault } from "@/serverFunctions/ai";
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
  const [editingDefault, setEditingDefault] = useState(false);
  const [editingAiDefault, setEditingAiDefault] = useState(false);
  const queryClient = useQueryClient();
  const onSetCap = useCallback((row: UsageAppRow) => setCapApp(row), []);
  const onSaved = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin", "usage"] });
  };
  const onAiDefaultSaved = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin", "usage"] });
    void queryClient.invalidateQueries({ queryKey: ["admin", "ai-default"] });
  };

  // The default model provider: not per month, so its own query.
  const aiDefaultQuery = useQuery({
    queryKey: ["admin", "ai-default"],
    queryFn: () => getAiDefault(),
  });

  const usageQuery = useQuery({
    queryKey: ["admin", "usage", month],
    queryFn: () => getUsage({ data: { month } }),
  });
  const summary = usageQuery.data;
  const defaultCap = summary?.defaultMonthlyCallCap ?? null;
  const defaultCostCap = summary?.defaultMonthlyCostCapMicros ?? null;
  const hasDefault = defaultCap !== null || defaultCostCap !== null;
  // The default row's words: "1,000 provider calls", "$20.00", or both.
  const defaultWords = [
    defaultCap === null ? null : `${formatCount(defaultCap)} provider calls`,
    defaultCostCap === null ? null : formatCostCap(defaultCostCap),
  ]
    .filter(Boolean)
    .join(" or ");
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

      {aiDefaultQuery.isError ? (
        <ErrorState
          message="Couldn't load the AI default."
          onRetry={() => void aiDefaultQuery.refetch()}
          isRetrying={aiDefaultQuery.isFetching}
        />
      ) : (
        <AiDefaultCard
          report={aiDefaultQuery.data}
          onChange={() => setEditingAiDefault(true)}
        />
      )}

      {usageQuery.isError ? (
        error
      ) : isEmpty ? (
        <EmptyState
          icon={Activity}
          title={`No usage in ${monthLabel(month)}`}
        />
      ) : (
        <>
          {summary ? (
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 rounded-lg border border-border px-4 py-3 text-sm">
              <div>
                <p className="font-medium">Default monthly cap</p>
                <p className="text-xs text-muted-foreground">
                  Every app without its own cap
                </p>
              </div>
              <div className="flex items-center gap-2 tabular-nums">
                {hasDefault ? (
                  <span>{defaultWords}</span>
                ) : (
                  <span className="text-muted-foreground">Unlimited</span>
                )}
                <Button
                  variant="ghost"
                  size="xs"
                  className="-mr-2"
                  aria-label={`${hasDefault ? "Edit" : "Set"} the default monthly cap`}
                  onClick={() => setEditingDefault(true)}
                >
                  {hasDefault ? "Edit" : "Set default"}
                </Button>
              </div>
            </div>
          ) : null}
          <section className="space-y-3">
            <SectionHeader
              title="By app"
              hint="Calls the Gateway makes for apps: AI providers and capabilities such as DataForSEO, counted together. Cost only where the provider reports it."
            />
            <UsageByAppTable
              rows={summary?.byApp ?? []}
              isLoading={usageQuery.isLoading}
              isCurrentMonth={isCurrentMonth}
              hasDefault={hasDefault}
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
              {summary && summary.byModel.length > 0 ? (
                <section className="space-y-3">
                  <SectionHeader title="By model" />
                  <UsageByModelTable rows={summary.byModel} isLoading={false} />
                </section>
              ) : null}
            </>
          )}
        </>
      )}
      {capApp ? (
        <SetMonthlyCapModal
          app={capApp}
          defaultCap={defaultCap}
          defaultCostCapMicros={defaultCostCap}
          isCurrentMonth={isCurrentMonth}
          onClose={() => setCapApp(null)}
          onSaved={onSaved}
        />
      ) : null}
      {editingAiDefault && aiDefaultQuery.data ? (
        <SetAiDefaultModal
          report={aiDefaultQuery.data}
          onClose={() => setEditingAiDefault(false)}
          onSaved={onAiDefaultSaved}
        />
      ) : null}
      {editingDefault ? (
        <SetDefaultCapModal
          defaultCap={defaultCap}
          defaultCostCapMicros={defaultCostCap}
          onClose={() => setEditingDefault(false)}
          onSaved={onSaved}
        />
      ) : null}
    </div>
  );
}
