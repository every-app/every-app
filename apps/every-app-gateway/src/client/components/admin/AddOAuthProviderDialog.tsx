import { useMemo, useState } from "react";
import { revalidateLogic } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { z } from "zod";
import { PROVIDER_ID } from "@every-app/sdk/internal";
import { cn } from "cn";
import { ErrorState } from "@/client/components/ErrorState";
import { useAppForm } from "@/client/components/form/useAppForm";
import { Alert, AlertDescription } from "@/client/components/ui/alert";
import { Badge } from "@/client/components/ui/badge";
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
import { RedirectUriSection, TerminalAlternative } from "./OAuthClientFields";

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
      "An id is 2 to 40 lowercase letters, digits and dashes, starting with a letter.",
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
  scopes: z.string().trim(),
  inject: z.enum(["form", "basic"]),
  pkce: z.boolean(),
  writes: z.boolean(),
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
    scopes: z.string(),
    inject: z.enum(["form", "basic"]),
    pkce: z.boolean(),
    writes: z.boolean(),
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
 * 4): step one picks a preset (the catalog's clients marked built in, the
 * shipped presets, or Custom), step two shows the redirect URI to register
 * at the provider's console and takes the client id and secret, plus, for
 * Custom, the provider's URLs, hosts and scopes. The secret is sent once
 * and never shown again. Render it only while it is open.
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
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
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

function PresetPicker({
  presets,
  onPick,
  onClose,
}: {
  presets: OAuthPresetSummary[];
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Add OAuth provider</DialogTitle>
        <DialogDescription>
          Pick the provider. Apps then reach it with each person&apos;s own
          account, through the Gateway; the client secret stays here.
        </DialogDescription>
      </DialogHeader>
      <ul
        className="flex max-h-[55vh] flex-col gap-1.5 overflow-y-auto"
        aria-label="Presets"
      >
        {presets.map((preset) => (
          <li key={preset.id}>
            <PresetButton
              title={preset.name}
              description={preset.description ?? undefined}
              badge={preset.builtIn ? "Built in" : undefined}
              onClick={() => onPick(preset.id)}
            />
          </li>
        ))}
        <li>
          <PresetButton
            title="Custom"
            description="Any OAuth 2 provider: its authorize and token URLs, API hosts and scopes."
            onClick={() => onPick(CUSTOM)}
          />
        </li>
      </ul>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </DialogFooter>
    </>
  );
}

function PresetButton({
  title,
  description,
  badge,
  onClick,
}: {
  title: string;
  description?: string;
  badge?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-lg border border-border px-3 py-2 text-left",
        "hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
      )}
    >
      <span className="flex items-center gap-2 text-sm font-medium">
        {title}
        {badge ? (
          <Badge variant="outline" size="sm">
            {badge}
          </Badge>
        ) : null}
      </span>
      {description ? (
        <span className="text-xs text-muted-foreground">{description}</span>
      ) : null}
    </button>
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
      scopes: "",
      inject: "form",
      pkce: true,
      writes: false,
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
            {custom
              ? "Describe the provider, register the redirect URI on its OAuth app, then paste the client."
              : (preset.hint ??
                "Make an OAuth app at the provider, register the redirect URI, then paste its client id and secret.")}
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
                    label="Id"
                    description="What apps list under capabilities; also the prefix of its settings."
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
                    description="Where the OAuth app is made."
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
                    description="The only hosts the token is sent to, comma separated."
                    placeholder="api.acme.com"
                    spellCheck={false}
                  />
                )}
              </form.AppField>
              <form.AppField name="scopes">
                {(field) => (
                  <field.TextField
                    label="Scopes"
                    description="The provider's scope strings, space or comma separated; one scope set named default."
                    placeholder="read write"
                    spellCheck={false}
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
                {(field) => (
                  <field.CheckboxField
                    label="PKCE"
                    description="Off only for a provider that refuses code_challenge."
                  />
                )}
              </form.AppField>
              <form.AppField name="writes">
                {(field) => (
                  <field.CheckboxField
                    label="Apps may write"
                    description="The scope set unlocks POST, PUT, PATCH and DELETE too."
                  />
                )}
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
            <RedirectUriSection
              redirectUri={preset.redirectUri}
              console={preset.console}
              providerName={preset.name}
            />
          )}

          {!custom && preset.scopeSets.length > 0 ? (
            <section className="flex flex-col gap-1">
              <p className="text-sm font-medium">Scope sets</p>
              <p className="text-xs text-muted-foreground">
                Apps declare the sets they need; a person is asked for the union
                when they connect.
              </p>
              <ul className="flex flex-wrap gap-1.5">
                {preset.scopeSets.map((set) => (
                  <li key={set.name}>
                    <Badge variant="secondary" size="sm" title={set.label}>
                      <span className="font-mono">{set.name}</span>
                    </Badge>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <form.AppField name="clientId">
            {(field) => (
              <field.TextField
                label="Client id"
                autoComplete="off"
                spellCheck={false}
                description="Leave both blank to add the provider now and set the client later."
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
                description="Stored sealed; never shown again. Blank for a public client."
              />
            )}
          </form.AppField>
          {!custom ? <TerminalAlternative settings={preset.settings} /> : null}

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
