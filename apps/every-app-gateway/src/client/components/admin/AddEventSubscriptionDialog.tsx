import { useMemo, useRef, useState } from "react";
import { revalidateLogic } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { z } from "zod";
import {
  EVENT_SECRET_MAX_LENGTH,
  EVENT_SECRET_MIN_LENGTH,
  EVENT_SUBSCRIPTION_NAME_MAX,
  EVENT_URL_MAX_LENGTH,
  type EventEmailRecipients,
} from "@every-app/sdk/internal";
import { cn } from "cn";
import { ErrorState } from "@/client/components/ErrorState";
import { ScrollBox } from "@/client/components/ScrollBox";
import { useAppForm } from "@/client/components/form/useAppForm";
import { Alert, AlertDescription } from "@/client/components/ui/alert";
import { Button } from "@/client/components/ui/button";
import { Checkbox } from "@/client/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/client/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/client/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/client/components/ui/radio-group";
import { Skeleton } from "@/client/components/ui/skeleton";
import { getErrorCode, getRuleErrorMessage } from "@/client/errors";
import {
  EVERYTHING,
  groupEventTypes,
  parsePatterns,
  patternsProblem,
  splitPatterns,
  subscriptionTarget,
  type EventTypeGroup,
} from "@/client/lib/events";
import { getFieldError } from "@/client/lib/forms";
import { listEventTypes } from "@/serverFunctions/events";
import type { EventSubscription } from "@/types/events";

/** The catalogue changes only with a Gateway release: read once a visit. */
const EVENT_TYPES_QUERY_KEY = ["admin", "eventTypes"] as const;

/** The catalogue, grouped for the checkboxes; the Events tab warms it. */
export function useEventTypeGroups() {
  return useQuery({
    queryKey: EVENT_TYPES_QUERY_KEY,
    queryFn: () => listEventTypes(),
    staleTime: Number.POSITIVE_INFINITY,
    select: (result) => groupEventTypes(result.types),
  });
}

/** What the dialog hands the page: a create's input, or an edit's changes. */
export type EventSubscriptionInput = {
  url?: string;
  email?: EventEmailRecipients;
  name?: string;
  events: string[];
  secret?: string;
};

type Kind = "webhook" | "email";

/** The fields a server refusal belongs under, by its code. */
type ServerField = "url" | "secret" | "custom";
const SERVER_FIELDS: Record<string, ServerField> = {
  EVENT_TARGET_REFUSED: "url",
  EVENT_SECRET_INVALID: "secret",
  EVENT_TYPE_UNKNOWN: "custom",
};

const KIND_CHOICES: { value: Kind; title: string; description: string }[] = [
  {
    value: "webhook",
    title: "Webhook",
    description: "A signed JSON POST to a URL: Slack, Zapier, n8n, an agent.",
  },
  {
    value: "email",
    title: "Email",
    description: "A short mail to the workspace's owners and admins.",
  },
];

const RECIPIENT_CHOICES: {
  value: EventEmailRecipients;
  title: string;
}[] = [
  { value: "owners", title: "Owners" },
  { value: "admins", title: "Owners and admins" },
];

function subscriptionSchema(editing: boolean) {
  return z
    .object({
      kind: z.enum(["webhook", "email"]),
      url: z.string(),
      recipients: z.enum(["owners", "admins"]),
      name: z
        .string()
        .max(
          EVENT_SUBSCRIPTION_NAME_MAX,
          `Use ${EVENT_SUBSCRIPTION_NAME_MAX} characters or fewer.`,
        ),
      everything: z.boolean(),
      selected: z.array(z.string()),
      custom: z.string(),
      secret: z.string(),
    })
    .superRefine((value, ctx) => {
      if (!editing && value.kind === "webhook") {
        const url = value.url.trim();
        if (!url) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["url"],
            message: "Enter the URL the events go to.",
          });
        } else if (url.length > EVENT_URL_MAX_LENGTH) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["url"],
            message: `A URL is at most ${EVENT_URL_MAX_LENGTH.toLocaleString("en-US")} characters.`,
          });
        } else if (!/^https?:\/\/[^\s/]+/i.test(url)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["url"],
            message: "Enter the full URL, https:// included.",
          });
        }
        const secret = value.secret;
        if (
          secret !== "" &&
          (secret.length < EVENT_SECRET_MIN_LENGTH ||
            secret.length > EVENT_SECRET_MAX_LENGTH ||
            /\s/.test(secret))
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["secret"],
            message: `A signing secret is ${EVENT_SECRET_MIN_LENGTH} to ${EVENT_SECRET_MAX_LENGTH} characters with no spaces, or blank.`,
          });
        }
      }
      if (value.everything) return;
      const custom = parsePatterns(value.custom);
      const problem = patternsProblem(custom);
      if (problem) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["custom"],
          message: problem.charAt(0).toUpperCase() + problem.slice(1) + ".",
        });
      }
      if (value.selected.length === 0 && custom.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["selected"],
          message: "Choose the events to send, or Everything.",
        });
      }
    });
}

interface AddEventSubscriptionDialogProps {
  /** Edit this subscription: its kind, URL and recipients stay as they are. */
  subscription?: EventSubscription;
  /** Rejects with the server's error, which the dialog shows where it belongs. */
  onSubmit: (input: EventSubscriptionInput) => Promise<void>;
  onClose: () => void;
}

/**
 * Adds a subscription (a webhook URL, or mail to the owners and admins),
 * or edits one's name and events. The events are the catalogue's types as
 * checkboxes grouped by prefix, a group's own `member.*`, "Everything",
 * and a field for patterns typed by hand (an app's own events,
 * `app.crm.*`). A secret left blank is generated by the Gateway, which
 * the page then shows once. The server's refusals (a URL the target rules
 * refuse, a secret or pattern it won't take) show under their field.
 * Render it only while it is open.
 */
export function AddEventSubscriptionDialog({
  subscription,
  onSubmit,
  onClose,
}: AddEventSubscriptionDialogProps) {
  const groupsQuery = useEventTypeGroups();
  const editing = subscription !== undefined;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        {groupsQuery.data ? (
          <SubscriptionForm
            groups={groupsQuery.data}
            subscription={subscription}
            onSubmit={onSubmit}
            onClose={onClose}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>
                {editing ? `Edit ${subscription.name}` : "Add subscription"}
              </DialogTitle>
              <DialogDescription>Loading the event types…</DialogDescription>
            </DialogHeader>
            {groupsQuery.isError ? (
              <ErrorState
                message="Couldn't load the event types."
                onRetry={() => void groupsQuery.refetch()}
                isRetrying={groupsQuery.isFetching}
              />
            ) : (
              <div className="space-y-3" aria-busy>
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
              </div>
            )}
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SubscriptionForm({
  groups,
  subscription,
  onSubmit,
  onClose,
}: {
  groups: EventTypeGroup[];
  subscription?: EventSubscription;
  onSubmit: (input: EventSubscriptionInput) => Promise<void>;
  onClose: () => void;
}) {
  const editing = subscription !== undefined;
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const initial = useMemo(
    () =>
      subscription
        ? splitPatterns(subscription.events, groups)
        : { everything: true, selected: [], custom: [] },
    [groups, subscription],
  );
  const schema = useMemo(() => subscriptionSchema(editing), [editing]);

  const form = useAppForm({
    defaultValues: {
      kind: (subscription?.sink ?? "webhook") as Kind,
      url: subscription?.url ?? "",
      recipients: (subscription?.recipients ??
        "admins") as EventEmailRecipients,
      name: subscription?.name ?? "",
      everything: initial.everything,
      selected: initial.selected,
      custom: initial.custom.join(", "),
      secret: "",
    },
    validationLogic: revalidateLogic(),
    validators: { onDynamic: schema },
    onSubmit: async ({ value }) => {
      setError(null);
      const events = value.everything
        ? [EVERYTHING]
        : [...value.selected, ...parsePatterns(value.custom)];
      const name = value.name.trim();
      const input: EventSubscriptionInput = editing
        ? { name, events }
        : value.kind === "webhook"
          ? {
              url: value.url.trim(),
              name: name || undefined,
              events,
              secret: value.secret || undefined,
            }
          : { email: value.recipients, name: name || undefined, events };
      try {
        await onSubmit(input);
      } catch (err) {
        const message = getRuleErrorMessage(
          err,
          editing
            ? "Failed to save the subscription"
            : "Failed to add the subscription",
        );
        const field = SERVER_FIELDS[getErrorCode(err) ?? ""];
        if (!field) {
          setError(message);
          return;
        }
        // Under the field it belongs to, until that field changes.
        form.setFieldMeta(field, (meta) => ({
          ...meta,
          errorMap: { ...meta.errorMap, onServer: message },
        }));
        requestAnimationFrame(() => {
          formRef.current
            ?.querySelector<HTMLElement>('[aria-invalid="true"]')
            ?.focus();
        });
      }
    },
  });

  /** A server refusal goes once its field changes. */
  const clearServerError = (field: ServerField) => {
    if (form.getFieldMeta(field)?.errorMap.onServer === undefined) return;
    form.setFieldMeta(field, (meta) => ({
      ...meta,
      errorMap: { ...meta.errorMap, onServer: undefined },
    }));
  };

  return (
    <form.AppForm>
      <div ref={formRef} className="contents">
        <form.Form className="flex min-w-0 flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              {editing ? `Edit ${subscription.name}` : "Add subscription"}
            </DialogTitle>
            <DialogDescription>
              {editing
                ? "Change its name and the events it takes."
                : "Each event goes to a URL as a signed JSON POST, or to the owners and admins by email."}
            </DialogDescription>
          </DialogHeader>

          {editing ? (
            <div className="space-y-1 rounded-lg border border-border bg-muted/40 px-3 py-2">
              <p className="text-xs text-muted-foreground">
                {subscription.sink === "email" ? "Email" : "Webhook"}
              </p>
              <p className="text-sm break-all">
                {subscriptionTarget(subscription)}
              </p>
            </div>
          ) : (
            <form.Field name="kind">
              {(field) => (
                <ChoiceCards
                  legend="Kind"
                  value={field.state.value}
                  onChange={(value) => field.handleChange(value)}
                  choices={KIND_CHOICES}
                />
              )}
            </form.Field>
          )}

          {editing ? null : (
            <form.Subscribe selector={(state) => state.values.kind}>
              {(kind) =>
                kind === "webhook" ? (
                  <form.AppField
                    name="url"
                    listeners={{ onChange: () => clearServerError("url") }}
                  >
                    {(field) => (
                      <field.TextField
                        label="URL"
                        type="url"
                        inputMode="url"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="https://hooks.example.com/everyapp"
                        autoFocus
                      />
                    )}
                  </form.AppField>
                ) : (
                  <form.Field name="recipients">
                    {(field) => (
                      <ChoiceCards
                        legend="Recipients"
                        value={field.state.value}
                        onChange={(value) => field.handleChange(value)}
                        choices={RECIPIENT_CHOICES}
                        columns
                      />
                    )}
                  </form.Field>
                )
              }
            </form.Subscribe>
          )}

          <form.Subscribe
            selector={(state) => ({
              kind: state.values.kind,
              url: state.values.url,
            })}
          >
            {({ kind, url }) => (
              <form.AppField name="name">
                {(field) => (
                  <field.TextField
                    label="Name"
                    maxLength={EVENT_SUBSCRIPTION_NAME_MAX}
                    placeholder={
                      editing
                        ? subscription.name
                        : kind === "email"
                          ? "Email owners and admins"
                          : (hostOf(url) ?? "Slack #ops")
                    }
                    description={
                      editing
                        ? undefined
                        : kind === "email"
                          ? "What the list calls it."
                          : "What the list calls it; the URL's host when blank."
                    }
                  />
                )}
              </form.AppField>
            )}
          </form.Subscribe>

          {/* "Everything", or the catalogue's types by group and patterns
              typed by hand; one error under them when nothing is chosen. */}
          <FieldSet className="min-w-0 gap-3">
            <FieldLegend variant="label" className="mb-0">
              Events
            </FieldLegend>
            <form.AppField name="everything">
              {(field) => (
                <field.CheckboxField
                  label="Everything"
                  description="Every event, the apps' own included; test pings go only where they are sent."
                />
              )}
            </form.AppField>
            <form.Subscribe selector={(state) => state.values.everything}>
              {(everything) =>
                everything ? null : (
                  <>
                    <form.Field name="selected">
                      {(field) => (
                        <EventTypePicker
                          groups={groups}
                          value={field.state.value}
                          onChange={(value) => field.handleChange(value)}
                          error={getFieldError(field.state.meta.errors)}
                        />
                      )}
                    </form.Field>
                    <form.AppField
                      name="custom"
                      listeners={{ onChange: () => clearServerError("custom") }}
                    >
                      {(field) => (
                        <field.TextField
                          label="Patterns"
                          autoComplete="off"
                          spellCheck={false}
                          placeholder="app.crm.*"
                          description="An app's own events, or any type or prefix: app.crm.* takes every event crm sends. Separate several with commas."
                        />
                      )}
                    </form.AppField>
                  </>
                )
              }
            </form.Subscribe>
          </FieldSet>

          {editing ? null : (
            <form.Subscribe selector={(state) => state.values.kind}>
              {(kind) =>
                kind === "webhook" ? (
                  <form.AppField
                    name="secret"
                    listeners={{ onChange: () => clearServerError("secret") }}
                  >
                    {(field) => (
                      <field.TextField
                        label="Signing secret (optional)"
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={EVENT_SECRET_MAX_LENGTH}
                        description="Leave blank to generate one."
                      />
                    )}
                  </form.AppField>
                ) : null
              }
            </form.Subscribe>
          )}

          {error ? (
            <Alert variant="destructive">
              <CircleAlert aria-hidden />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <form.Subscribe selector={(state) => state.isSubmitting}>
              {(isSubmitting) => (
                <Button
                  variant="ghost"
                  onClick={onClose}
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
              )}
            </form.Subscribe>
            <form.SubmitButton>
              {editing ? "Save" : "Add subscription"}
            </form.SubmitButton>
          </DialogFooter>
        </form.Form>
      </div>
    </form.AppForm>
  );
}

/** A URL's host, for the Name placeholder; null until it parses. */
function hostOf(url: string): string | null {
  try {
    return new URL(url.trim()).host || null;
  } catch {
    return null;
  }
}

/** Two or three exclusive choices as cards, for Kind and Recipients. */
function ChoiceCards<T extends string>({
  legend,
  value,
  onChange,
  choices,
  columns = false,
}: {
  legend: string;
  value: T;
  onChange: (value: T) => void;
  choices: readonly { value: T; title: string; description?: string }[];
  /** Side by side at every width (short titles only). */
  columns?: boolean;
}) {
  return (
    <FieldSet className="gap-2">
      <FieldLegend variant="label" className="mb-0">
        {legend}
      </FieldLegend>
      <RadioGroup
        value={value}
        onValueChange={(next) => {
          const picked = choices.find((choice) => choice.value === next);
          if (picked) onChange(picked.value);
        }}
        className={cn("gap-2", columns ? "grid-cols-2" : "sm:grid-cols-2")}
      >
        {choices.map((choice) => (
          <FieldLabel key={choice.value} className="min-w-0 border-border">
            <Field orientation="horizontal">
              <FieldContent>
                <FieldTitle>{choice.title}</FieldTitle>
                {choice.description ? (
                  <FieldDescription className="text-xs">
                    {choice.description}
                  </FieldDescription>
                ) : null}
              </FieldContent>
              <RadioGroupItem value={choice.value} aria-label={choice.title} />
            </Field>
          </FieldLabel>
        ))}
      </RadioGroup>
    </FieldSet>
  );
}

/**
 * The catalogue as checkboxes: a group's box takes its prefix pattern
 * (`member.*`, which also covers the types it adds later), and then its
 * types read as taken; a type's box takes that one type.
 */
function EventTypePicker({
  groups,
  value,
  onChange,
  error,
}: {
  groups: EventTypeGroup[];
  value: string[];
  onChange: (value: string[]) => void;
  error: string | null;
}) {
  const chosen = new Set(value);
  const errorId = "event-types-error";

  const toggleGroup = (group: EventTypeGroup, checked: boolean) => {
    const inGroup = new Set(group.types.map((info) => info.type));
    const rest = value.filter(
      (pattern) => pattern !== group.pattern && !inGroup.has(pattern),
    );
    onChange(checked ? [...rest, group.pattern] : rest);
  };
  const toggleType = (type: string, checked: boolean) => {
    onChange(
      checked ? [...value, type] : value.filter((pattern) => pattern !== type),
    );
  };

  return (
    <div className="space-y-1.5">
      <ScrollBox className="max-h-64" deps={[groups]}>
        {/* One flat list, a group's row then its types', so "N more
            below" counts rows. */}
        <ul aria-describedby={error ? errorId : undefined}>
          {groups.flatMap((group) => {
            const whole = chosen.has(group.pattern);
            const some = group.types.some((info) => chosen.has(info.type));
            return [
              <li
                key={group.group}
                className="border-t border-border first:border-t-0"
              >
                <label className="flex cursor-pointer items-center gap-3 bg-muted/40 px-3 py-2 text-sm hover:bg-muted">
                  <Checkbox
                    checked={whole}
                    indeterminate={!whole && some}
                    onCheckedChange={(checked) => toggleGroup(group, checked)}
                  />
                  <span className="font-medium">{group.label}</span>
                  <span className="ml-auto font-mono text-xs text-muted-foreground">
                    {group.pattern}
                  </span>
                </label>
              </li>,
              ...group.types.map((info) => (
                <li key={info.type}>
                  <label
                    className={cn(
                      "flex cursor-pointer items-start gap-3 py-1.5 pr-3 pl-9 text-sm hover:bg-muted",
                      whole && "cursor-default hover:bg-transparent",
                    )}
                  >
                    <Checkbox
                      // Taken by the group's box: checked, and dimmed.
                      className={cn("mt-0.5", whole && "opacity-60")}
                      checked={whole || chosen.has(info.type)}
                      disabled={whole}
                      onCheckedChange={(checked) =>
                        toggleType(info.type, checked)
                      }
                    />
                    <span className="min-w-0">
                      <span className="block font-mono text-xs">
                        {info.type}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {info.description}
                      </span>
                    </span>
                  </label>
                </li>
              )),
            ];
          })}
        </ul>
      </ScrollBox>
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </div>
  );
}
