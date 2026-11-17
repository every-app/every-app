import { createFileRoute } from "@tanstack/react-router";
import { USAGE_REPORT_DOCS_URL } from "@every-app/sdk/internal";
import { CodeBlock } from "@/client/components/CodeBlock";
import { ErrorState } from "@/client/components/ErrorState";
import {
  SettingsSection,
  SettingsTab,
} from "@/client/components/SettingsLayout";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import {
  useSetUsageReports,
  useUsageReports,
} from "@/client/hooks/useUsageReports";

export const Route = createFileRoute("/_app/admin/usage-reports")({
  component: UsageReportsTab,
});

type Status = NonNullable<ReturnType<typeof useUsageReports>["data"]>;

/** Where things stand, in one sentence. */
export function usageReportsLine(status: Status): string {
  switch (status.reason) {
    case "unavailable":
      return "This Gateway doesn't send usage reports.";
    case "setting":
      return "Off. Nothing is sent. The TELEMETRY_DISABLED setting is set, so reports can't be turned on here.";
    case "off":
      return "Off. Nothing is sent.";
    case "unpublished":
      return "This Gateway was built from source, so it sends nothing. Below is what a published release would send.";
    default:
      if (status.notice) return status.notice.headline;
      return status.lastReportedDay
        ? `On. The last report was for ${status.lastReportedDay}.`
        : "On. No report has been sent yet.";
  }
}

/**
 * Manage workspace → Usage reports: whether this Gateway sends Every App
 * its daily report, the exact report that goes next, the last one sent,
 * and the switch. Owners and admins.
 */
function UsageReportsTab() {
  const query = useUsageReports();
  const mutation = useSetUsageReports();
  const status = query.data;
  if (query.isError) {
    return (
      <ErrorState
        message="Couldn't load usage reports."
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!status) return null;
  const on = status.usageReports === "on";
  // On a build from source the switch still records the choice.
  const chosenOn = on || status.reason === "unpublished";

  return (
    <SettingsTab>
      <SettingsSection
        title={
          <span className="flex items-center gap-2">
            Usage reports
            <Badge variant={on ? "success" : "outline"}>
              {on ? "On" : "Off"}
            </Badge>
          </span>
        }
        hint={
          <>
            Once a day this Gateway sends Every App a few rounded counts, so we
            know how many Gateways are running and how much they are used. Never
            your domain, names, emails or anything inside an app.{" "}
            <a
              href={USAGE_REPORT_DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              What it sends
            </a>
          </>
        }
        action={
          status.canChange ? (
            <Button
              variant="outline"
              pending={mutation.isPending}
              onClick={() => mutation.mutate(!chosenOn)}
            >
              {chosenOn ? "Turn off" : "Turn on"}
            </Button>
          ) : null
        }
      >
        <p className="text-sm text-muted-foreground">
          {usageReportsLine(status)}
        </p>
      </SettingsSection>

      {status.nextReport ? (
        <SettingsSection
          level={3}
          title="The next report"
          hint={`Exactly what will be sent to ${new URL(status.endpoint).host}, and all of it. Counts are rounded down: 37 is sent as 30.`}
        >
          <CodeBlock code={JSON.stringify(status.nextReport, null, 2)} />
        </SettingsSection>
      ) : null}

      {status.lastReport ? (
        <SettingsSection level={3} title="The last report sent">
          <CodeBlock code={JSON.stringify(status.lastReport, null, 2)} />
        </SettingsSection>
      ) : null}
    </SettingsTab>
  );
}
