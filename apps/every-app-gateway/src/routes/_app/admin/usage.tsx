import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { Activity, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { EmptyState } from "@/client/components/EmptyState";
import { ErrorState } from "@/client/components/ErrorState";
import {
  SettingsSection,
  SettingsSummary,
  SettingsTab,
} from "@/client/components/SettingsLayout";
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
import { formatCostCap, monthLabel, monthOptions } from "@/client/lib/usage";
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
  const defaultCostCap = summary?.defaultMonthlyCostCapMicros ?? null;
  const hasDefault = defaultCostCap !== null;
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
    <SettingsTab>
      <SettingsSection
        title="Usage"
        hint="How much your apps use AI and other paid services, and what it costs."
        action={
          <>
            <Select
              items={months}
              value={month}
              onValueChange={(value) => {
                if (value !== null) setMonth(value);
              }}
            >
              <SelectTrigger
                aria-label="Month"
                className="min-w-44 border-border bg-card"
              >
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
          </>
        }
      >
        <div className="grid gap-4 md:grid-cols-2">
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
          {summary && !isEmpty && !usageQuery.isError ? (
            <SettingsSummary
              label="Default monthly cap"
              value={
                defaultCostCap !== null ? (
                  formatCostCap(defaultCostCap)
                ) : (
                  <span className="text-muted-foreground">Unlimited</span>
                )
              }
              action={
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`${hasDefault ? "Edit" : "Set"} the default monthly cap`}
                  onClick={() => setEditingDefault(true)}
                >
                  {hasDefault ? "Edit" : "Set default"}
                </Button>
              }
            />
          ) : null}
        </div>
      </SettingsSection>

      {usageQuery.isError ? (
        error
      ) : isEmpty ? (
        <EmptyState
          icon={Activity}
          title={`No usage in ${monthLabel(month)}`}
        />
      ) : (
        <>
          <SettingsSection level={3} title="By app">
            <UsageByAppTable
              rows={summary?.byApp ?? []}
              isLoading={usageQuery.isLoading}
              isCurrentMonth={isCurrentMonth}
              onSetCap={onSetCap}
            />
          </SettingsSection>
          {nothingCounted ? null : (
            <>
              <SettingsSection level={3} title="By member">
                <UsageByMemberTable
                  rows={summary?.byMember ?? []}
                  isLoading={usageQuery.isLoading}
                />
              </SettingsSection>
              <SettingsSection level={3} title="By provider">
                <UsageByTargetTable
                  rows={summary?.byTarget ?? []}
                  isLoading={usageQuery.isLoading}
                />
              </SettingsSection>
              {summary && summary.byModel.length > 0 ? (
                <SettingsSection level={3} title="By model">
                  <UsageByModelTable rows={summary.byModel} isLoading={false} />
                </SettingsSection>
              ) : null}
            </>
          )}
        </>
      )}
      {capApp ? (
        <SetMonthlyCapModal
          app={capApp}
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
          defaultCostCapMicros={defaultCostCap}
          onClose={() => setEditingDefault(false)}
          onSaved={onSaved}
        />
      ) : null}
    </SettingsTab>
  );
}
