import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import { Skeleton } from "@/client/components/ui/skeleton";
import type { AiDefaultReport } from "./SetAiDefaultModal";

type Resolution = AiDefaultReport["resolution"];

/** One plain sentence for where the default came from. */
function aiDefaultSourceSentence(resolution: Resolution): string {
  switch (resolution.source) {
    case "setting":
      return "Chosen here.";
    case "order":
      return "First in the order with its key set.";
    case "none":
      return `Nothing is set yet: apps that need a chat model show Needs setup until one key is set; the first in the order is ${resolution.label} (${resolution.settings.join(", ")}).`;
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
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 rounded-lg border border-border px-4 py-3 text-sm">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-medium">AI default</p>
        {resolution ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="break-all">
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
            </div>
            <p className="text-xs text-muted-foreground">
              {aiDefaultSourceSentence(resolution)}
            </p>
            {resolution.problem ? (
              <p className="text-xs text-destructive">{resolution.problem}</p>
            ) : null}
          </>
        ) : (
          <>
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-3 w-40" />
          </>
        )}
      </div>
      <Button
        variant="ghost"
        size="xs"
        className="-mr-2"
        aria-label="Change the AI default"
        disabled={!report}
        onClick={onChange}
      >
        Change
      </Button>
    </div>
  );
}
