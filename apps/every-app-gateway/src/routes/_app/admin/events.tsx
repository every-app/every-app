import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { List, Plus } from "lucide-react";
import { toast } from "sonner";
import {
  AddEventSubscriptionDialog,
  useEventTypeGroups,
  type EventSubscriptionInput,
} from "@/client/components/admin/AddEventSubscriptionDialog";
import {
  EVENT_DELIVERIES_QUERY_KEY,
  EventDeliveriesSheet,
} from "@/client/components/admin/EventDeliveriesSheet";
import { EventSecretRevealDialog } from "@/client/components/admin/EventSecretRevealDialog";
import { EventSubscriptionsTable } from "@/client/components/admin/EventSubscriptionsTable";
import { ConfirmDialog } from "@/client/components/ConfirmDialog";
import { ErrorState } from "@/client/components/ErrorState";
import { SectionHeader } from "@/client/components/PageHeader";
import { Button } from "@/client/components/ui/button";
import { getServerErrorMessage } from "@/client/errors";
import { useActiveOrganization } from "@/client/hooks/useActiveOrganization";
import {
  EVENTS_DOCS_URL,
  deliveryState,
  describeDeliveryError,
} from "@/client/lib/events";
import {
  createEventSubscription,
  deleteEventSubscription,
  listEventSubscriptions,
  testEventSubscription,
  updateEventSubscription,
} from "@/serverFunctions/events";
import type { EventSubscription } from "@/types/events";

export const Route = createFileRoute("/_app/admin/events")({
  component: EventsPage,
});

const SUBSCRIPTIONS_KEY = ["admin", "eventSubscriptions"] as const;

/** Which deliveries the sheet shows: one subscription's, or everyone's. */
type DeliveriesView = { subscription: EventSubscription | null };

/**
 * Manage workspace → Events (docs/design/2026-10-events-out.md, section
 * 10): the organization's subscriptions with how each last delivered, the
 * Add and Edit dialog, the generated signing secret shown once, Send
 * test, the switch, Remove (a built-in row is turned off instead), and
 * the deliveries with the dead letters and Redeliver. Nothing on this page
 * ever lists a secret: the one a create generated lives in this page's
 * state until its dialog closes.
 */
function EventsPage() {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<EventSubscription | null>(null);
  const [removing, setRemoving] = useState<EventSubscription | null>(null);
  const [revealed, setRevealed] = useState<{
    name: string;
    secret: string;
  } | null>(null);
  const [deliveries, setDeliveries] = useState<DeliveriesView | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const { data: organization } = useActiveOrganization();
  // Warm the catalogue, so the Add dialog opens on its checkboxes.
  useEventTypeGroups();

  const subscriptionsQuery = useQuery({
    queryKey: SUBSCRIPTIONS_KEY,
    queryFn: () => listEventSubscriptions(),
  });
  const subscriptions = subscriptionsQuery.data?.subscriptions ?? [];

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: SUBSCRIPTIONS_KEY });

  const create = async (input: EventSubscriptionInput) => {
    const result = await createEventSubscription({ data: input });
    setAdding(false);
    await refresh();
    if (result.secret) {
      setRevealed({ name: result.subscription.name, secret: result.secret });
    } else {
      toast.success(`${result.subscription.name} added`);
    }
  };

  const save = async (
    subscription: EventSubscription,
    input: EventSubscriptionInput,
  ) => {
    await updateEventSubscription({
      data: { id: subscription.id, name: input.name, events: input.events },
    });
    setEditing(null);
    await refresh();
    toast.success("Subscription saved");
  };

  const toggle = useMutation({
    mutationFn: (input: {
      subscription: EventSubscription;
      enabled: boolean;
    }) =>
      updateEventSubscription({
        data: { id: input.subscription.id, enabled: input.enabled },
      }),
    onMutate: ({ subscription, enabled }) => {
      setTogglingId(subscription.id);
      // The switch moves at once; a failure puts it back.
      queryClient.setQueryData<{ subscriptions: EventSubscription[] }>(
        SUBSCRIPTIONS_KEY,
        (old) =>
          old && {
            subscriptions: old.subscriptions.map((entry) =>
              entry.id === subscription.id ? { ...entry, enabled } : entry,
            ),
          },
      );
    },
    onSuccess: (_, { subscription, enabled }) => {
      toast.success(
        enabled
          ? `${subscription.name} is on`
          : `${subscription.name} is off: no events are queued for it`,
      );
    },
    onError: (error) => {
      toast.error(
        getServerErrorMessage(error, "Failed to change the subscription"),
      );
    },
    onSettled: async () => {
      setTogglingId(null);
      await refresh();
    },
  });

  const test = useMutation({
    mutationFn: (subscription: EventSubscription) =>
      testEventSubscription({ data: { id: subscription.id } }),
    onSuccess: async ({ delivery }, subscription) => {
      const state = delivery ? deliveryState(delivery) : null;
      if (!delivery || state === "pending") {
        toast.success(`Test event queued for ${subscription.name}`);
      } else if (state === "delivered") {
        toast.success(
          subscription.sink === "email"
            ? `Test mailed to ${delivery.lastStatusCode ?? 0} ${delivery.lastStatusCode === 1 ? "person" : "people"}`
            : `Test delivered to ${subscription.name}`,
        );
      } else {
        const error = delivery.lastError
          ? describeDeliveryError(delivery.lastError)
          : null;
        toast.error(`Test to ${subscription.name} failed`, {
          description: error
            ? [error.label, error.detail].filter(Boolean).join(": ")
            : undefined,
        });
      }
      await Promise.all([
        refresh(),
        queryClient.invalidateQueries({ queryKey: EVENT_DELIVERIES_QUERY_KEY }),
      ]);
    },
    onError: (error) => {
      toast.error(getServerErrorMessage(error, "Failed to send the test"));
    },
  });

  const remove = useMutation({
    mutationFn: (subscription: EventSubscription) =>
      deleteEventSubscription({ data: { id: subscription.id } }),
    onSuccess: async (result, subscription) => {
      setRemoving(null);
      await refresh();
      toast.success(
        result.disabled
          ? `${subscription.name} is turned off`
          : "Subscription removed",
      );
    },
    onError: (error) => {
      toast.error(
        getServerErrorMessage(error, "Failed to remove the subscription"),
      );
    },
  });

  const addAction = (
    <Button onClick={() => setAdding(true)}>
      <Plus data-icon="inline-start" />
      Add subscription
    </Button>
  );

  return (
    <div className="space-y-6">
      {/* The buttons go under the heading on a phone, so neither squeezes
          the other. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <SectionHeader
          title="Events"
          hint={
            <>
              Signed webhooks and emails for what happens in this workspace.{" "}
              <a href={EVENTS_DOCS_URL} target="_blank" rel="noreferrer">
                How it works
              </a>
            </>
          }
        />
        {subscriptions.length > 0 ? (
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => setDeliveries({ subscription: null })}
            >
              <List data-icon="inline-start" />
              Deliveries
            </Button>
            {addAction}
          </div>
        ) : null}
      </div>

      <EventSubscriptionsTable
        subscriptions={subscriptions}
        isLoading={subscriptionsQuery.isLoading}
        error={
          subscriptionsQuery.isError ? (
            <ErrorState
              message="Couldn't load the event subscriptions."
              onRetry={() => void subscriptionsQuery.refetch()}
              isRetrying={subscriptionsQuery.isFetching}
            />
          ) : null
        }
        addAction={addAction}
        togglingId={togglingId}
        testingId={test.isPending ? (test.variables?.id ?? null) : null}
        onToggle={(subscription, enabled) =>
          toggle.mutate({ subscription, enabled })
        }
        onTest={(subscription) => test.mutate(subscription)}
        onDeliveries={(subscription) => setDeliveries({ subscription })}
        onEdit={setEditing}
        onRemove={setRemoving}
      />

      {adding ? (
        <AddEventSubscriptionDialog
          onSubmit={create}
          onClose={() => setAdding(false)}
        />
      ) : null}

      {editing ? (
        <AddEventSubscriptionDialog
          subscription={editing}
          onSubmit={(input) => save(editing, input)}
          onClose={() => setEditing(null)}
        />
      ) : null}

      {revealed ? (
        <EventSecretRevealDialog
          name={revealed.name}
          secret={revealed.secret}
          onClose={() => setRevealed(null)}
        />
      ) : null}

      {removing ? (
        <ConfirmDialog
          title={`Remove “${removing.name}”?`}
          confirmLabel={removing.builtin ? "Turn off" : "Remove subscription"}
          destructive={!removing.builtin}
          pending={remove.isPending}
          onClose={() => setRemoving(null)}
          onConfirm={() => remove.mutate(removing)}
        >
          {removing.builtin
            ? "It is built in, so it is turned off, not removed: no events go to it until it is turned on again."
            : "Events stop going to it at once."}
        </ConfirmDialog>
      ) : null}

      {deliveries ? (
        <EventDeliveriesSheet
          subscription={deliveries.subscription}
          subscriptions={subscriptions}
          envelope={{
            gateway: window.location.origin,
            organization: organization ?? null,
          }}
          onClose={() => setDeliveries(null)}
        />
      ) : null}
    </div>
  );
}
