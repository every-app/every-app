import { useMemo, useState } from "react";
import { revalidateLogic } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { CircleAlert } from "lucide-react";
import { z } from "zod";
import { PROVIDER_ID } from "@every-app/sdk/internal";
import { ErrorState } from "@/client/components/ErrorState";
import { ProviderMark } from "@/client/components/ProviderIcon";
import {
  CardSlot,
  DataTable,
  useDataTable,
} from "@/client/components/table/DataTable";
import { useTableSearch } from "@/client/components/table/useTableSearch";
import { useAppForm } from "@/client/components/form/useAppForm";
import { Alert, AlertDescription } from "@/client/components/ui/alert";
import { Button } from "@/client/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/client/components/ui/dialog";
import { Skeleton } from "@/client/components/ui/skeleton";
import { getRuleErrorMessage } from "@/client/errors";
import { customSpecOf, slugOf } from "@/client/lib/oauthProviders";
import {
  OAUTH_CLIENT_ID_MAX,
  OAUTH_CLIENT_SECRET_MAX,
  type AddOAuthProviderInput,
} from "@/schemas/oauth-provider";
import {
  listOAuthPresets,
  type OAuthPresetSummary,
} from "@/serverFunctions/providers";
import { HintText, RedirectUriSection } from "./OAuthClientFields";
import { ProviderHosts } from "./ProviderHosts";

/** The presets change only with a Gateway release: read once a visit. */
const OAUTH_PRESETS_QUERY_KEY = ["admin", "oauthPresets"] as const;

function useOAuthPresets() {
  return useQuery({
    queryKey: OAUTH_PRESETS_QUERY_KEY,
    queryFn: () => listOAuthPresets(),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

const CUSTOM = "custom";

/** A custom provider, as the form takes it; it becomes a spec of design section 3. */
const customSchema = z.object({
  name: z.string().trim().min(1, "Name the provider.").max(60),
  id: z
    .string()
    .trim()
    .regex(
      PROVIDER_ID,
      "An ID is 2 to 40 lowercase letters, digits and dashes, starting with a letter.",
    ),
  console: z
    .string()
    .trim()
    .url("Enter the console URL, https:// included.")
    .startsWith("https://", "The console URL is https."),
  authorizeUrl: z
    .string()
    .trim()
    .url("Enter the authorize URL, https:// included.")
    .startsWith("https://", "The authorize URL is https."),
  tokenUrl: z
    .string()
    .trim()
    .url("Enter the token URL, https:// included.")
    .startsWith("https://", "The token URL is https."),
  hosts: z.string().trim().min(1, "Name at least one API host."),
  scopeSeparator: z.enum(["space", "comma"]),
  inject: z.enum(["form", "basic"]),
  pkce: z.boolean(),
});

const clientSchema = z.object({
  clientId: z.string().trim().max(OAUTH_CLIENT_ID_MAX, "Too long."),
  clientSecret: z.string().max(OAUTH_CLIENT_SECRET_MAX, "Too long."),
});

const formSchema = customSchema.merge(clientSchema);
type FormValues = z.infer<typeof formSchema>;

/** A preset's form: the custom fields are present but unchecked. */
const presetSchema = z
  .object({
    name: z.string(),
    id: z.string(),
    console: z.string(),
    authorizeUrl: z.string(),
    tokenUrl: z.string(),
    hosts: z.string(),
    scopeSeparator: z.enum(["space", "comma"]),
    inject: z.enum(["form", "basic"]),
    pkce: z.boolean(),
  })
  .merge(clientSchema);

interface AddOAuthProviderDialogProps {
  /** The redirect URI a custom provider gets, by id: `/connect/<id>/callback` on this Gateway. */
  redirectUriFor: (id: string) => string;
  /** Rejects with the server's error, which the dialog shows. */
  onSubmit: (input: AddOAuthProviderInput) => Promise<void>;
  onClose: () => void;
}

/**
 * Adds an OAuth provider (docs/design/2026-10-oauth-providers.md section
 * 4): step one picks a preset (Google, Microsoft, Slack, GitHub and the other
 * shipped presets, searchable and paged, or Custom provider), step two shows the redirect URI to register
 * at the provider's console and takes the client id and secret, plus, for
 * Custom, the provider's URLs and hosts. Scopes are each app's, in its
 * everyapp.config.ts. The secret is sent once and never shown again.
 * Render it only while it is open.
 */
export function AddOAuthProviderDialog({
  redirectUriFor,
  onSubmit,
  onClose,
}: AddOAuthProviderDialogProps) {
  const presetsQuery = useOAuthPresets();
  const [picked, setPicked] = useState<string | null>(null);
  const presets = presetsQuery.data?.presets;
  const preset = presets?.find((each) => each.id === picked) ?? null;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent showCloseButton={false} className="sm:max-w-2xl">
        {!presets ? (
          <>
            <DialogHeader>
              <DialogTitle>Add OAuth provider</DialogTitle>
              <DialogDescription>Loading the presets…</DialogDescription>
            </DialogHeader>
            {presetsQuery.isError ? (
              <ErrorState
                message="Couldn't load the presets."
                onRetry={() => void presetsQuery.refetch()}
                isRetrying={presetsQuery.isFetching}
              />
            ) : (
              <div className="space-y-3" aria-busy>
                <Skeleton className="h-9 w-full" />
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
        ) : picked === null ? (
          <PresetPicker
            presets={presets}
            onPick={setPicked}
            onClose={onClose}
          />
        ) : (
          <ClientForm
            preset={preset}
            redirectUriFor={redirectUriFor}
            onBack={() => setPicked(null)}
            onSubmit={onSubmit}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The picker shows this many presets a page. */
const PRESETS_PAGE_SIZE = 6;

function presetColumns(
  onPick: (id: string) => void,
): ColumnDef<OAuthPresetSummary>[] {
  return [
    {
      id: "name",
      header: "Provider",
      meta: { cellClassName: "w-56" },
      cell: ({ row: { original: preset } }) => (
        <div className="flex items-center gap-3">
          {/* A fixed slot, so names line up whether or not a row has a mark. */}
          <span className="flex size-5 shrink-0 items-center justify-center">
            <ProviderMark id={preset.id} className="size-4.5" />
          </span>
          {/* A button for the keyboard; the whole row takes a click. */}
          <button
            type="button"
            onClick={() => onPick(preset.id)}
            className="cursor-pointer truncate rounded-sm text-left font-medium focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {preset.name}
          </button>
        </div>
      ),
    },
    {
      id: "description",
      header: "What it reaches",
      meta: {
        cellClassName: "whitespace-normal text-muted-foreground",
        card: CardSlot.BareDetail,
      },
      cell: ({ row: { original: preset } }) => preset.description,
    },
  ];
}

function presetSearchText(preset: OAuthPresetSummary) {
  return [preset.name, preset.id, preset.description];
}

/** The presets, searchable and paged; Custom is the footer's, for a provider with no preset. */
function PresetPicker({
  presets,
  onPick,
  onClose,
}: {
  presets: OAuthPresetSummary[];
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const { rows, search } = useTableSearch(presets, presetSearchText, "presets");
  const columns = useMemo(() => presetColumns(onPick), [onPick]);
  const table = useDataTable({
    data: rows,
    columns,
    getRowId: (preset) => preset.id,
    initialState: { pagination: { pageIndex: 0, pageSize: PRESETS_PAGE_SIZE } },
  });
  return (
    <>
      <DialogHeader>
        <DialogTitle>Add OAuth provider</DialogTitle>
      </DialogHeader>
      <section aria-label="Presets" className="min-w-0">
        <DataTable
          table={table}
          search={search}
          onRowClick={(row) => onPick(row.original.id)}
          empty={{ title: "No presets" }}
        />
      </section>
      <DialogFooter className="sm:justify-between">
        <Button variant="outline" onClick={() => onPick(CUSTOM)}>
          Custom provider
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </DialogFooter>
    </>
  );
}

function ClientForm({
  preset,
  redirectUriFor,
  onBack,
  onSubmit,
}: {
  /** Null: a custom provider. */
  preset: OAuthPresetSummary | null;
  redirectUriFor: (id: string) => string;
  onBack: () => void;
  onSubmit: (input: AddOAuthProviderInput) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const custom = preset === null;
  const schema = useMemo(() => (custom ? formSchema : presetSchema), [custom]);

  const form = useAppForm({
    defaultValues: {
      name: "",
      id: "",
      console: "",
      authorizeUrl: "",
      tokenUrl: "",
      hosts: "",
      scopeSeparator: "space",
      inject: "form",
      pkce: true,
      clientId: "",
      clientSecret: "",
    } as FormValues,
    validationLogic: revalidateLogic(),
    validators: { onDynamic: schema },
    onSubmit: async ({ value }) => {
      setError(null);
      const clientId = value.clientId.trim();
      const client = clientId
        ? {
            clientId,
            ...(value.clientSecret ? { clientSecret: value.clientSecret } : {}),
          }
        : {};
      const input: AddOAuthProviderInput = custom
        ? { spec: customSpecOf(value), ...client }
        : { preset: preset.id, ...client };
      try {
        await onSubmit(input);
      } catch (err) {
        setError(getRuleErrorMessage(err, "Failed to add the provider"));
      }
    },
  });

  return (
    <form.AppForm>
      <form.Form className="flex min-w-0 flex-col gap-4">
        <DialogHeader>
          <DialogTitle>
            {custom ? "Add a custom OAuth provider" : `Add ${preset.name}`}
          </DialogTitle>
          <DialogDescription>
            {custom ? (
              "Describe the provider, register the redirect URI on its OAuth app, then paste the client."
            ) : preset.hint ? (
              <HintText text={preset.hint} />
            ) : (
              "Make an OAuth app at the provider, register the redirect URI, then paste its client ID and secret."
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[55vh] min-w-0 flex-col gap-4 overflow-y-auto px-0.5">
          {custom ? (
            <>
              <form.AppField
                name="name"
                listeners={{
                  onChange: ({ value }) => {
                    if (!form.getFieldMeta("id")?.isTouched) {
                      form.setFieldValue("id", slugOf(value));
                    }
                  },
                }}
              >
                {(field) => (
                  <field.TextField
                    label="Name"
                    placeholder="Acme Cloud"
                    autoFocus
                  />
                )}
              </form.AppField>
              <form.AppField name="id">
                {(field) => (
                  <field.TextField
                    label="ID"
                    placeholder="acme-cloud"
                    spellCheck={false}
                  />
                )}
              </form.AppField>
              <form.AppField name="console">
                {(field) => (
                  <field.TextField
                    label="Console URL"
                    type="url"
                    placeholder="https://console.acme.com/apps"
                    spellCheck={false}
                  />
                )}
              </form.AppField>
              <form.AppField name="authorizeUrl">
                {(field) => (
                  <field.TextField
                    label="Authorize URL"
                    type="url"
                    placeholder="https://acme.com/oauth/authorize"
                    spellCheck={false}
                  />
                )}
              </form.AppField>
              <form.AppField name="tokenUrl">
                {(field) => (
                  <field.TextField
                    label="Token URL"
                    type="url"
                    placeholder="https://acme.com/oauth/token"
                    spellCheck={false}
                  />
                )}
              </form.AppField>
              <form.AppField name="hosts">
                {(field) => (
                  <field.TextField
                    label="API hosts"
                    placeholder="api.acme.com"
                    spellCheck={false}
                  />
                )}
              </form.AppField>
              <form.AppField name="scopeSeparator">
                {(field) => (
                  <field.SelectField
                    label="Scope separator"
                    items={[
                      { value: "space", label: "Space (most providers)" },
                      { value: "comma", label: "Comma" },
                    ]}
                  />
                )}
              </form.AppField>
              <form.AppField name="inject">
                {(field) => (
                  <field.SelectField
                    label="Client on the token request"
                    items={[
                      { value: "form", label: "Form body (most providers)" },
                      { value: "basic", label: "HTTP Basic" },
                    ]}
                  />
                )}
              </form.AppField>
              <form.AppField name="pkce">
                {(field) => <field.CheckboxField label="PKCE" />}
              </form.AppField>
              <form.Subscribe selector={(state) => state.values.id}>
                {(id) =>
                  PROVIDER_ID.test(id) ? (
                    <RedirectUriSection
                      redirectUri={redirectUriFor(id)}
                      console={null}
                      providerName="the provider"
                    />
                  ) : null
                }
              </form.Subscribe>
            </>
          ) : (
            <>
              <RedirectUriSection
                redirectUri={preset.redirectUri}
                console={preset.console}
                providerName={preset.name}
              />
              <ProviderHosts hosts={preset.hosts} what="connected accounts" />
            </>
          )}

          <form.AppField name="clientId">
            {(field) => (
              <field.TextField
                label="Client ID"
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </form.AppField>
          <form.AppField name="clientSecret">
            {(field) => (
              <field.TextField
                label="Client secret"
                type="password"
                autoComplete="new-password"
                spellCheck={false}
              />
            )}
          </form.AppField>

          <p className="text-xs text-muted-foreground">
            Leave both blank to set the client later.
          </p>

          {error ? (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onBack}>
            Back
          </Button>
          <form.SubmitButton>
            {custom ? "Add provider" : `Add ${preset.name}`}
          </form.SubmitButton>
        </DialogFooter>
      </form.Form>
    </form.AppForm>
  );
}
