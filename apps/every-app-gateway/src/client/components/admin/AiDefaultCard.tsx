import { SettingsSummary } from "@/client/components/SettingsLayout";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import { Skeleton } from "@/client/components/ui/skeleton";
import type { AiDefaultReport } from "./SetAiDefaultModal";

type Resolution = AiDefaultReport["resolution"];

/** Where the default came from, when nobody chose it here. */
function aiDefaultSource(resolution: Resolution): string | null {
  switch (resolution.source) {
    case "setting":
      return null;
    case "order":
      return "Automatic";
    case "none":
      return "No AI key set yet.";
  }
}

/**
 * Manage workspace → Usage → AI default: the provider and model apps get
 * when they ask for a chat model without naming one, where that came
 * from, and Change. `report` is undefined while it loads.
 */
export function AiDefaultCard({
  report,
  onChange,
}: {
  report: AiDefaultReport | undefined;
  onChange: () => void;
}) {
  const resolution = report?.resolution;
  return (
    <SettingsSummary
      label="AI default"
      value={
        resolution ? (
          <>
            <span className="wrap-break-word">
              {resolution.label} · {resolution.model}
            </span>
            {resolution.configured ? null : (
              <Badge variant="warning">
                Not configured · {resolution.settings.join(", ")}
              </Badge>
            )}
            {resolution.via === "ai-gateway" ? (
              <Badge variant="info">Through Cloudflare AI Gateway</Badge>
            ) : null}
          </>
        ) : (
          <Skeleton className="my-1 h-4 w-56" />
        )
      }
      detail={
        resolution ? (
          <>
            {aiDefaultSource(resolution) ? (
              <p>{aiDefaultSource(resolution)}</p>
            ) : null}
            {resolution.problem ? (
              <p className="text-destructive">{resolution.problem}</p>
            ) : null}
          </>
        ) : (
          <Skeleton className="h-3 w-40" />
        )
      }
      action={
        <Button
          variant="outline"
          size="sm"
          aria-label="Change the AI default"
          disabled={!report}
          onClick={onChange}
        >
          Change
        </Button>
      }
    />
  );
}
