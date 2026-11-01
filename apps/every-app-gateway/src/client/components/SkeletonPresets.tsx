import { cn } from "cn";
import { Page } from "@/client/components/PageHeader";
import { Card, CardContent } from "@/client/components/ui/card";
import { Skeleton } from "@/client/components/ui/skeleton";

// Loading layouts built from the shadcn Skeleton primitive.

/** Table body rows. The first column is twice as wide, for the row label. */
function SkeletonTableRows({
  rows = 8,
  columns = 5,
  className,
}: {
  rows?: number;
  columns?: number;
  className?: string;
}) {
  return (
    <div className={cn("space-y-3", className)} aria-busy>
      {Array.from({ length: rows }, (_, row) => (
        <div
          key={row}
          className="grid gap-3"
          style={{
            gridTemplateColumns: `repeat(${columns + 1}, minmax(0, 1fr))`,
          }}
        >
          {Array.from({ length: columns }, (_cell, column) => (
            <Skeleton
              key={column}
              className={cn("h-4", column === 0 && "col-span-2")}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** A card of table rows, for a section whose data has not arrived. */
export function SkeletonCard({ className }: { className?: string }) {
  return (
    <Card className={className} aria-busy>
      <CardContent>
        <SkeletonTableRows rows={6} columns={4} />
      </CardContent>
    </Card>
  );
}

/**
 * A whole page whose data has not arrived: the page frame with a title line
 * and one card, so the real page replaces it without a jump.
 */
export function SkeletonPage() {
  return (
    <div aria-busy>
      <Page>
        {/* A line box the size of PageHeader's title. */}
        <div className="flex h-10 items-center">
          <Skeleton className="h-6 w-48" />
        </div>
        <SkeletonCard />
      </Page>
    </div>
  );
}
