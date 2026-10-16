import { cn } from "cn";
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
 * A whole page whose data has not arrived: the standard page frame with a
 * header and one card, so the real page replaces it without a jump.
 */
export function SkeletonPage() {
  return (
    <div className="px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8" aria-busy>
      <div className="mx-auto max-w-7xl space-y-4">
        {/* Line boxes the size of PageHeader's title and description. */}
        <div className="space-y-1">
          <div className="flex h-8 items-center">
            <Skeleton className="h-6 w-48" />
          </div>
          <div className="flex h-5 items-center">
            <Skeleton className="h-3.5 w-72 max-w-full" />
          </div>
        </div>
        <SkeletonCard />
      </div>
    </div>
  );
}
