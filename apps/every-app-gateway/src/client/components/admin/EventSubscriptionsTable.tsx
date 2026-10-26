import { createContext, useContext, type ReactNode } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  ArrowUpRight,
  Bot,
  List,
  Mail,
  MessageSquare,
  Pause,
  Pencil,
  Play,
  Send,
  Trash2,
  TriangleAlert,
  Webhook,
  Zap,
} from "lucide-react";
import { RowActionsMenu } from "@/client/components/RowActionsMenu";
import { DataTable, useDataTable } from "@/client/components/table/DataTable";
import { DateCell } from "@/client/components/table/DateCell";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/client/components/ui/dropdown-menu";
import { Switch } from "@/client/components/ui/switch";
import {
  EVENTS_CLI_LINE,
  EVENTS_DOCS_URL,
  isEverything,
  subscriptionTarget,
} from "@/client/lib/events";
import type {
  EventLastDeliveryStatus,
  EventSubscription,
} from "@/types/events";
import { CountCell } from "./CountCell";

type SubscriptionActions = {
  onToggle: (subscription: EventSubscription, enabled: boolean) => void;
  onTest: (subscription: EventSubscription) => void;
  onDeliveries: (subscription: EventSubscription) => void;
  onEdit: (subscription: EventSubscription) => void;
  onRemove: (subscription: EventSubscription) => void;
  /** The subscription whose switch is being saved: it waits. */
  togglingId: string | null;
  /** The subscription a test is being sent to. */
  testingId: string | null;
};

interface EventSubscriptionsTableProps extends SubscriptionActions {
  subscriptions: EventSubscription[];
  isLoading: boolean;
  /** A load failure, shown above the rows (or in their place). */
  error?: ReactNode;
  /** The "Add subscription" button, for the empty state. */
  addAction?: ReactNode;
}

// The cells read the page's callbacks from context, so the columns stay one
// module-level array (see GroupsTable).
const SubscriptionRowContext = createContext<SubscriptionActions | null>(null);

function useSubscriptionActions() {
  const context = useContext(SubscriptionRowContext);
  if (!context) {
    throw new Error("EventSubscriptionsTable cells need their context");
  }
  return context;
}

/** How many event chips a row shows before "+N more". */
const CHIPS_SHOWN = 3;

const STATUS_BADGES: Record<
  EventLastDeliveryStatus,
  { label: string; variant: "success" | "warning" | "destructive" }
> = {
  delivered: { label: "Delivered", variant: "success" },
  failed: { label: "Failed", variant: "warning" },
  dead: { label: "Dead", variant: "destructive" },
};

function NameCell({ subscription }: { subscription: EventSubscription }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="truncate font-medium">{subscription.name}</span>
      {subscription.builtin ? (
        <Badge variant="outline" size="sm" className="shrink-0">
          Built-in
        </Badge>
      ) : null}
    </div>
  );
}

function TargetCell({ subscription }: { subscription: EventSubscription }) {
  const Icon = subscription.sink === "email" ? Mail : Webhook;
  const target = subscriptionTarget(subscription);
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate" title={target}>
        {target}
      </span>
    </span>
  );
}

function EventsCell({ subscription }: { subscription: EventSubscription }) {
  if (isEverything(subscription.events)) {
    return <Badge variant="soft">All events</Badge>;
  }
  const shown = subscription.events.slice(0, CHIPS_SHOWN);
  const more = subscription.events.length - shown.length;
  return (
    <span className="flex flex-wrap justify-end gap-1 md:justify-start">
      {shown.map((pattern) => (
        <Badge key={pattern} variant="outline" className="font-mono">
          {pattern}
        </Badge>
      ))}
      {more > 0 ? (
        <Badge
          variant="secondary"
          title={subscription.events.slice(CHIPS_SHOWN).join(", ")}
        >
          +{more} more
        </Badge>
      ) : null}
    </span>
  );
}

function LastDeliveryCell({
  subscription,
}: {
  subscription: EventSubscription;
}) {
  const { onDeliveries } = useSubscriptionActions();
  const status = subscription.lastDeliveryStatus;
  if (!subscription.lastDeliveryAt || !status) {
    return <span className="text-muted-foreground">Nothing sent yet</span>;
  }
  const badge = STATUS_BADGES[status];
  return (
    <span className="flex flex-col items-end gap-0.5 md:items-start">
      <span className="flex items-center gap-2">
        <Badge variant={badge.variant}>{badge.label}</Badge>
        <span className="text-xs text-muted-foreground">
          <DateCell value={subscription.lastDeliveryAt} withTime />
        </span>
      </span>
      {subscription.consecutiveFailures > 0 ? (
        // How many attempts in a row failed, in the warning colour; the
        // count opens the deliveries, where each one says why.
        <span className="flex items-center gap-1 text-xs text-warning-foreground dark:text-warning">
          <TriangleAlert className="size-3 shrink-0" aria-hidden />
          <CountCell
            count={subscription.consecutiveFailures}
            noun="failure"
            aria-label={`Show the deliveries of ${subscription.name}`}
            onClick={() => onDeliveries(subscription)}
            className="text-xs text-inherit hover:text-inherit"
          />
          <span>in a row</span>
        </span>
      ) : null}
    </span>
  );
}

function EnabledCell({ subscription }: { subscription: EventSubscription }) {
  const { onToggle, togglingId } = useSubscriptionActions();
  return (
    <Switch
      checked={subscription.enabled}
      disabled={togglingId === subscription.id}
      aria-label={`Send events to ${subscription.name}`}
      onCheckedChange={(checked) => onToggle(subscription, checked)}
    />
  );
}

function ActionsCell({ subscription }: { subscription: EventSubscription }) {
  const actions = useSubscriptionActions();
  return (
    <RowActionsMenu label={`Actions for ${subscription.name}`}>
      <DropdownMenuItem
        disabled={actions.testingId === subscription.id}
        onClick={() => actions.onTest(subscription)}
      >
        <Send />
        Send test
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => actions.onDeliveries(subscription)}>
        <List />
        Deliveries
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => actions.onEdit(subscription)}>
        <Pencil />
        Edit
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={actions.togglingId === subscription.id}
        onClick={() => actions.onToggle(subscription, !subscription.enabled)}
      >
        {subscription.enabled ? <Pause /> : <Play />}
        {subscription.enabled ? "Disable" : "Enable"}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        variant="destructive"
        onClick={() => actions.onRemove(subscription)}
      >
        <Trash2 />
        Remove
      </DropdownMenuItem>
    </RowActionsMenu>
  );
}

const columns: ColumnDef<EventSubscription>[] = [
  {
    id: "name",
    header: "Name",
    meta: { cellClassName: "max-w-[240px]" },
    cell: ({ row }) => <NameCell subscription={row.original} />,
  },
  {
    id: "target",
    header: "Target",
    meta: { cellClassName: "max-w-[280px]" },
    cell: ({ row }) => <TargetCell subscription={row.original} />,
  },
  {
    id: "events",
    header: "Events",
    meta: { cellClassName: "max-w-[280px]" },
    cell: ({ row }) => <EventsCell subscription={row.original} />,
  },
  {
    id: "lastDelivery",
    header: "Last delivery",
    cell: ({ row }) => <LastDeliveryCell subscription={row.original} />,
  },
  {
    id: "enabled",
    header: "On",
    meta: { headerClassName: "w-14" },
    cell: ({ row }) => <EnabledCell subscription={row.original} />,
  },
  {
    id: "actions",
    header: () => <span className="sr-only">Actions</span>,
    meta: { headerClassName: "w-10" },
    cell: ({ row }) => <ActionsCell subscription={row.original} />,
  },
];

/** The three things people wire events to, for the empty state. */
const DESTINATIONS = [
  {
    icon: MessageSquare,
    title: "Slack",
    detail: "Post each event to a channel",
  },
  { icon: Zap, title: "Zapier or n8n", detail: "Start a workflow" },
  { icon: Bot, title: "Your own agent", detail: "Check the signature and act" },
] as const;

/**
 * Where events go, for a workspace with no subscription yet: the three
 * destinations people wire, then Add, the docs, and the CLI line.
 */
function EventsEmptyActions({ addAction }: { addAction?: ReactNode }) {
  return (
    <div className="flex w-full flex-col items-center gap-5">
      <ul className="w-full divide-y divide-border rounded-lg border border-border text-left">
        {DESTINATIONS.map(({ icon: Icon, title, detail }) => (
          <li key={title} className="flex items-center gap-3 px-3 py-2.5">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-foreground/5 text-muted-foreground">
              <Icon className="size-3.5" aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">
                {title}
              </span>
              <span className="block text-xs text-muted-foreground">
                {detail}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {addAction}
        <Button
          variant="ghost"
          nativeButton={false}
          render={<a href={EVENTS_DOCS_URL} target="_blank" rel="noreferrer" />}
        >
          How events work
          <ArrowUpRight data-icon="inline-end" />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Or from a terminal:{" "}
        <code className="font-mono text-foreground/80">{EVENTS_CLI_LINE}</code>
      </p>
    </div>
  );
}

export function EventSubscriptionsTable({
  subscriptions,
  isLoading,
  error,
  addAction,
  ...actions
}: EventSubscriptionsTableProps) {
  const table = useDataTable({
    data: subscriptions,
    columns,
    getRowId: (subscription) => subscription.id,
  });

  return (
    <SubscriptionRowContext.Provider value={actions}>
      <DataTable
        table={table}
        isLoading={isLoading}
        error={error}
        empty={{
          icon: Webhook,
          title: "No event subscriptions yet",
          description:
            "Get a signed webhook or an email when someone joins, an app is installed, a cap is reached or an agent's tool call is blocked.",
          action: <EventsEmptyActions addAction={addAction} />,
        }}
      />
    </SubscriptionRowContext.Provider>
  );
}
