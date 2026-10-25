import { useMemo, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { Braces, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { CodeBlock } from "@/client/components/CodeBlock";
import { EmptyState } from "@/client/components/EmptyState";
import { ErrorState } from "@/client/components/ErrorState";
import { ScrollBox } from "@/client/components/ScrollBox";
import { SegmentedToggle } from "@/client/components/SegmentedToggle";
import { DateCell } from "@/client/components/table/DateCell";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/client/components/ui/sheet";
import { Skeleton } from "@/client/components/ui/skeleton";
import { getServerErrorMessage } from "@/client/errors";
import {
  DELIVERY_STATE_LABELS,
  deliveryState,
  describeDeliveryError,
  eventEnvelope,
  type DeliveryState,
} from "@/client/lib/events";
import { listEventDeliveries, redeliverEvent } from "@/serverFunctions/events";
import type { EventDelivery, EventSubscription } from "@/types/events";

/** Deliveries a page; the server answers at most 100. */
const PAGE_SIZE = 25;

/** What every deliveries query's key starts with, so a change refreshes them all. */
export const EVENT_DELIVERIES_QUERY_KEY = ["admin", "eventDeliveries"] as const;

type Filter = "all" | "dead";
const FILTER_ITEMS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "dead", label: "Dead" },
];

const STATE_VARIANTS: Record<
  DeliveryState,
  "success" | "warning" | "destructive" | "secondary"
> = {
  delivered: "success",
  failed: "warning",
  dead: "destructive",
  pending: "secondary",
};

/** What the envelope adds to every stored event: where it came from. */
type EnvelopeContext = Parameters<typeof eventEnvelope>[1];

interface EventDeliveriesSheetProps {
  /** One subscription's deliveries; null for the organization's. */
  subscription: EventSubscription | null;
  /** Every subscription, to name each delivery's in the organization's list. */
  subscriptions: EventSubscription[];
  /** Open on the dead ones: the dead letters. */
  initialFilter?: Filter;
  envelope: EnvelopeContext;
  onClose: () => void;
}

/**
 * The deliveries of the last 30 days, newest first: of one subscription,
 * or the organization's with a Dead filter for the dead letters. Each row
 * says the event, when, how many attempts, how it stands, the last error
 * and the next attempt; a failed or dead one has Redeliver (the schedule
 * starts over), and "Show payload" opens the envelope the receiver got.
 * Render it only while it is open.
 */
export function EventDeliveriesSheet({
  subscription,
  subscriptions,
  initialFilter = "all",
  envelope,
  onClose,
}: EventDeliveriesSheetProps) {
  const [filter, setFilter] = useState<Filter>(initialFilter);
  const [openPayload, setOpenPayload] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const subscriptionId = subscription?.id;

  const query = useInfiniteQuery({
    queryKey: [...EVENT_DELIVERIES_QUERY_KEY, subscriptionId ?? "all", filter],
    queryFn: ({ pageParam }) =>
      listEventDeliveries({
        data: {
          subscriptionId,
          status: filter === "dead" ? "dead" : undefined,
          before: pageParam,
          limit: PAGE_SIZE,
        },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const deliveries = useMemo(
    () => query.data?.pages.flatMap((page) => page.deliveries) ?? [],
    [query.data],
  );
  const byId = useMemo(
    () => new Map(subscriptions.map((entry) => [entry.id, entry])),
    [subscriptions],
  );

  const redeliver = useMutation({
    mutationFn: (delivery: EventDelivery) =>
      redeliverEvent({ data: { deliveryId: delivery.id } }),
    onSuccess: async (result) => {
      const state = result.delivery ? deliveryState(result.delivery) : null;
      if (state === "delivered") toast.success("Redelivered");
      else if (state === "dead")
        toast.error("Redelivered, and it failed for good");
      else {
        toast.warning("Redelivery failed; it is retried on the usual schedule");
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: EVENT_DELIVERIES_QUERY_KEY }),
        queryClient.invalidateQueries({
          queryKey: ["admin", "eventSubscriptions"],
        }),
      ]);
    },
    onError: (error) => {
      toast.error(getServerErrorMessage(error, "Failed to redeliver"));
    },
  });

  const loadMore = async () => {
    const result = await query.fetchNextPage();
    if (result.isError) toast.error("Failed to load more deliveries");
  };

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
        <SheetHeader className="pr-12">
          <SheetTitle>
            {subscription ? `Deliveries to ${subscription.name}` : "Deliveries"}
          </SheetTitle>
          <SheetDescription>
            The last 30 days, newest first. A failed delivery is retried for
            about 35 hours, then it is dead; Redeliver starts it over.
          </SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-3">
          <SegmentedToggle
            items={FILTER_ITEMS}
            value={filter}
            onChange={(next) => {
              setFilter(next);
              setOpenPayload(null);
            }}
            showLabels
          />
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
          {query.isLoading ? (
            <div className="space-y-2" aria-busy>
              {Array.from({ length: 5 }, (_, index) => (
                <Skeleton key={index} className="h-16 w-full" />
              ))}
            </div>
          ) : query.isError && deliveries.length === 0 ? (
            <ErrorState
              message="Couldn't load the deliveries."
              onRetry={() => void query.refetch()}
              isRetrying={query.isFetching}
            />
          ) : deliveries.length === 0 ? (
            <EmptyState
              title={
                filter === "dead"
                  ? "No dead deliveries"
                  : "No deliveries in the last 30 days"
              }
              description={
                filter === "dead"
                  ? "A delivery that fails every attempt shows here, ready to send again."
                  : "Each event a subscription takes is one delivery here."
              }
            />
          ) : (
            <>
              <ScrollBox
                frameClassName="flex min-h-0 flex-1 flex-col"
                className="min-h-0 flex-1"
                deps={[deliveries, openPayload]}
              >
                <ul className="divide-y divide-border">
                  {deliveries.map((delivery) => (
                    <DeliveryRow
                      key={delivery.id}
                      delivery={delivery}
                      subscriptionName={
                        subscription
                          ? null
                          : (byId.get(delivery.subscriptionId)?.name ??
                            "A removed subscription")
                      }
                      sink={
                        (subscription ?? byId.get(delivery.subscriptionId))
                          ?.sink ?? null
                      }
                      payloadOpen={openPayload === delivery.id}
                      onTogglePayload={() =>
                        setOpenPayload((open) =>
                          open === delivery.id ? null : delivery.id,
                        )
                      }
                      envelope={envelope}
                      redelivering={
                        redeliver.isPending &&
                        redeliver.variables?.id === delivery.id
                      }
                      onRedeliver={() => redeliver.mutate(delivery)}
                    />
                  ))}
                </ul>
              </ScrollBox>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-muted-foreground tabular-nums">
                  Showing {deliveries.length}{" "}
                  {deliveries.length === 1 ? "delivery" : "deliveries"}
                </span>
                {query.hasNextPage ? (
                  <Button
                    variant="outline"
                    size="sm"
                    pending={query.isFetchingNextPage}
                    onClick={() => void loadMore()}
                  >
                    Load more
                  </Button>
                ) : null}
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function DeliveryRow({
  delivery,
  subscriptionName,
  sink,
  payloadOpen,
  onTogglePayload,
  envelope,
  redelivering,
  onRedeliver,
}: {
  delivery: EventDelivery;
  /** The subscription's name, in the organization's list; null in one subscription's. */
  subscriptionName: string | null;
  /** How it was delivered; null when the subscription is gone. */
  sink: EventSubscription["sink"] | null;
  payloadOpen: boolean;
  onTogglePayload: () => void;
  envelope: EnvelopeContext;
  redelivering: boolean;
  onRedeliver: () => void;
}) {
  const state = deliveryState(delivery);
  const error = delivery.lastError
    ? describeDeliveryError(delivery.lastError)
    : null;
  const canRedeliver = state === "failed" || state === "dead";
  const payloadId = `payload-${delivery.id}`;

  return (
    <li data-delivery={delivery.id} className="space-y-1.5 px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate font-mono text-xs font-medium">
          {delivery.event?.type ?? "Event gone"}
        </span>
        <Badge variant={STATE_VARIANTS[state]}>
          {DELIVERY_STATE_LABELS[state]}
        </Badge>
      </div>
      {delivery.event?.summary ? (
        <p className="text-sm">{delivery.event.summary}</p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {subscriptionName ? `${subscriptionName} · ` : null}
        <DateCell value={delivery.createdAt} withTime />
        {" · "}
        {delivery.attempts} {delivery.attempts === 1 ? "attempt" : "attempts"}
        {delivery.lastStatusCode && state === "delivered"
          ? ` · ${deliveredCode(sink, delivery.lastStatusCode)}`
          : null}
        {state === "failed" && delivery.nextAttemptAt ? (
          <>
            {" · next attempt "}
            <DateCell value={delivery.nextAttemptAt} withTime />
          </>
        ) : null}
      </p>
      {error && state !== "delivered" ? (
        <p className="text-xs">
          <span
            className={
              state === "dead"
                ? "text-destructive"
                : "text-warning-foreground dark:text-warning"
            }
          >
            {error.label}
          </span>
          {error.detail ? (
            <span className="text-muted-foreground"> · {error.detail}</span>
          ) : null}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2 pt-0.5">
        {canRedeliver ? (
          <Button
            variant="outline"
            size="xs"
            pending={redelivering}
            onClick={onRedeliver}
          >
            {redelivering ? null : <RotateCcw data-icon="inline-start" />}
            Redeliver
          </Button>
        ) : null}
        {delivery.event ? (
          <Button
            variant="ghost"
            size="xs"
            aria-expanded={payloadOpen}
            aria-controls={payloadOpen ? payloadId : undefined}
            onClick={onTogglePayload}
          >
            <Braces data-icon="inline-start" />
            {payloadOpen ? "Hide payload" : "Show payload"}
          </Button>
        ) : null}
      </div>
      {payloadOpen && delivery.event ? (
        <div id={payloadId}>
          <CodeBlock
            code={JSON.stringify(
              eventEnvelope(delivery.event, envelope),
              null,
              2,
            )}
            successMessage="Payload copied"
          />
        </div>
      ) : null}
    </li>
  );
}

/** An email delivery's code is how many people were mailed; a webhook's is the HTTP status. */
function deliveredCode(
  sink: EventSubscription["sink"] | null,
  code: number,
): string {
  if (sink === "email") return `mailed to ${code}`;
  if (sink === "webhook") return `HTTP ${code}`;
  return String(code);
}
