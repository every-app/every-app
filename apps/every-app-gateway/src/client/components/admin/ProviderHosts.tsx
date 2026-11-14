import { ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/client/components/ui/collapsible";

/**
 * Where a provider's credential can go: the only hosts the Gateway attaches
 * it to, behind a closed row at the foot of where an admin is about to
 * hand one over. Nothing when the provider names no hosts.
 */
export function ProviderHosts({
  hosts,
  what,
}: {
  hosts: readonly string[];
  /** What apps use: "this key", "connected accounts". */
  what: string;
}) {
  if (hosts.length === 0) return null;
  return (
    <Collapsible className="text-xs text-muted-foreground">
      <CollapsibleTrigger className="group/hosts flex cursor-pointer items-center gap-1 rounded outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
        <ChevronRight
          className="-ml-1 size-3.5 shrink-0 transition-transform group-data-panel-open/hosts:rotate-90 motion-reduce:transition-none"
          aria-hidden
        />
        Allowed hosts
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="pt-1.5 pl-3.5">
          Apps can use {what} only to call{" "}
          <span className="font-mono wrap-anywhere">{hosts.join(", ")}</span>.
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}
