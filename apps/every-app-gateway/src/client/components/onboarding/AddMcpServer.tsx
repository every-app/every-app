import { useEffect, useId, useState, type ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import {
  remoteMcpIdFromUrl,
  remoteMcpIdProblem,
  remoteMcpRedirectUri,
  type RemoteMcpRiskDefault,
} from "@every-app/sdk/internal";
import { ChoiceSelect } from "@/client/components/ChoiceSelect";
import { CodeBlock } from "@/client/components/CodeBlock";
import { Alert, AlertDescription } from "@/client/components/ui/alert";
import { Button } from "@/client/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/client/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/client/components/ui/field";
import { Input } from "@/client/components/ui/input";
import { asSentence, getErrorCode, getRuleErrorMessage } from "@/client/errors";
import {
  MCP_APP_COPY,
  type AddCredentialChoice,
} from "@/client/lib/mcpAppCopy";
import { addRemoteMcpApp } from "@/serverFunctions/mcpApps";
import { listProviders } from "@/serverFunctions/providers";
import type { AddedRemoteMcpApp } from "@/types/mcpApp";

const COPY = MCP_APP_COPY.addForm;

/** The static kinds: one value the operator sets as the app's own provider row's setting. */
function isStatic(kind: AddCredentialChoice): boolean {
  return (
    kind === "bearer" ||
    kind === "header" ||
    kind === "query" ||
    kind === "basic"
  );
}

/** A provider the form offers: an API-key provider, or an OAuth one the Gateway connects people to. */
interface ProviderChoice {
  id: string;
  name: string;
  kind: "api_key" | "oauth";
}

/** What the form sends `addRemoteMcpApp`. */
interface AddMcpServerInput {
  url: string;
  id?: string;
  auth: {
    kind: AddCredentialChoice;
    header?: string;
    prefix?: string;
    param?: string;
    provider?: string;
    clientId?: string;
    clientSecret?: string;
  };
  risk: RemoteMcpRiskDefault;
}

interface FormState {
  url: string;
  name: string;
  kind: AddCredentialChoice;
  header: string;
  prefix: string;
  param: string;
  provider: string;
  clientId: string;
  clientSecret: string;
  risk: RemoteMcpRiskDefault;
}

/** The id the server will settle on: the name given, else the URL's host's. */
function derivedId(state: FormState): string {
  return state.name.trim() || remoteMcpIdFromUrl(state.url.trim()) || "";
}

/** Each field's problem, in the rules' words where the rules have them. */
function problemsOf(state: FormState, askClient: boolean) {
  const url = state.url.trim();
  let urlProblem: string | null = null;
  if (!url) urlProblem = COPY.errors.url;
  else {
    try {
      new URL(url);
    } catch {
      urlProblem = COPY.errors.urlParse;
    }
  }
  const name = state.name.trim();
  const nameProblem = name
    ? remoteMcpIdProblem(name)
    : url && !urlProblem && !remoteMcpIdFromUrl(url)
      ? COPY.errors.noName
      : null;
  return {
    url: urlProblem,
    name: nameProblem ? asSentence(nameProblem) : null,
    header:
      state.kind === "header" && !state.header.trim()
        ? COPY.errors.header
        : null,
    param:
      state.kind === "query" && !state.param.trim() ? COPY.errors.param : null,
    provider:
      state.kind === "provider" && !state.provider
        ? COPY.errors.provider
        : null,
    clientId:
      state.kind === "oauth" && askClient && !state.clientId.trim()
        ? COPY.errors.clientId
        : null,
  };
}

/** The form's input for the server function, from what the person entered. */
function addMcpServerInput(
  state: FormState,
  providerKind: ProviderChoice["kind"] | undefined,
  askClient: boolean,
): AddMcpServerInput {
  const name = state.name.trim();
  const prefix = state.prefix.trim();
  let auth: AddMcpServerInput["auth"];
  switch (state.kind) {
    case "bearer":
      auth = { kind: "bearer", ...(prefix ? { prefix } : {}) };
      break;
    case "header":
      auth = {
        kind: "header",
        header: state.header.trim(),
        ...(state.prefix ? { prefix: state.prefix } : {}),
      };
      break;
    case "query":
      auth = { kind: "query", param: state.param.trim() };
      break;
    case "oauth": {
      const secret = state.clientSecret.trim();
      auth = askClient
        ? {
            kind: "oauth",
            clientId: state.clientId.trim(),
            ...(secret ? { clientSecret: secret } : {}),
          }
        : { kind: "oauth" };
      break;
    }
    case "provider":
      auth = {
        kind: "provider",
        provider: state.provider,
      };
      break;
    default:
      auth = { kind: state.kind };
  }
  return {
    url: state.url.trim(),
    ...(name ? { id: name } : {}),
    auth,
    risk: state.risk,
  };
}

/** The providers a remote server can take, from the registry: API keys, and OAuth with the Gateway's flow. */
function useProviderChoices(active: boolean): ProviderChoice[] | null {
  const [providers, setProviders] = useState<ProviderChoice[] | null>(null);
  useEffect(() => {
    if (!active || providers !== null) return;
    let live = true;
    listProviders()
      .then(({ providers: all }) => {
        if (!live) return;
        setProviders(
          all
            .filter(
              (provider) =>
                provider.kind === "api_key" || provider.kind === "oauth",
            )
            .map((provider) => ({
              id: provider.id,
              name: provider.name,
              kind: provider.kind as ProviderChoice["kind"],
            })),
        );
      })
      .catch(() => {
        if (live) setProviders([]);
      });
    return () => {
      live = false;
    };
  }, [active, providers]);
  return providers;
}

/**
 * "Add an MCP server", from its section in Admin → Apps: the form and, once
 * the Gateway has added the server, what to do next. Render it only while it
 * is open.
 */
export function AddMcpServerDialog({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  /** After the Gateway added it: the list reads it again. */
  onAdded: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-xl">
        <AddMcpServerView onAdded={onAdded} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The form (URL, name, credential, risk default) and, once added, what to do
 * next: the command that sets a static credential, the link that connects an
 * account for OAuth, or how many tools are on /mcp now.
 */
function AddMcpServerView({ onAdded }: { onAdded: () => void }) {
  const [state, setState] = useState<FormState>({
    url: "",
    name: "",
    kind: "none",
    header: "",
    prefix: "",
    param: "",
    provider: "",
    clientId: "",
    clientSecret: "",
    risk: "annotations",
  });
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  // The server couldn't register the Gateway as a client: ask for one.
  const [askClient, setAskClient] = useState(false);
  const [added, setAdded] = useState<AddedRemoteMcpApp | null>(null);
  const providers = useProviderChoices(state.kind === "provider");
  const ids = {
    url: useId(),
    name: useId(),
    kind: useId(),
    header: useId(),
    prefix: useId(),
    param: useId(),
    provider: useId(),
    clientId: useId(),
    clientSecret: useId(),
    risk: useId(),
  };

  if (added) return <AddedMcpServer added={added} />;

  const problems = problemsOf(state, askClient);
  const shown = {
    url: attempted ? problems.url : null,
    name: attempted || state.name.trim() ? problems.name : null,
    header: attempted ? problems.header : null,
    param: attempted ? problems.param : null,
    provider: attempted ? problems.provider : null,
    clientId: attempted ? problems.clientId : null,
  };
  const id = derivedId(state);
  const chosenProvider = providers?.find(
    (provider) => provider.id === state.provider,
  );
  const set = (change: Partial<FormState>) => {
    setServerError(null);
    setState((current) => ({ ...current, ...change }));
  };

  const submit = async () => {
    setAttempted(true);
    if (Object.values(problems).some(Boolean)) return;
    setPending(true);
    setServerError(null);
    try {
      const result = await addRemoteMcpApp({
        data: addMcpServerInput(state, chosenProvider?.kind, askClient),
      });
      setAdded(result);
      onAdded();
    } catch (error) {
      if (
        state.kind === "oauth" &&
        getErrorCode(error) === "REMOTE_MCP_OAUTH_NO_CLIENT"
      ) {
        setAskClient(true);
      }
      setServerError(getRuleErrorMessage(error, COPY.errors.failed));
    } finally {
      setPending(false);
    }
  };

  const riskHelp = COPY.riskItems.find((item) => item.value === state.risk);
  const credentialHelp =
    [
      COPY.credentialHelp[state.kind],
      isStatic(state.kind) ? COPY.tokenSettingHelp : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined;
  const redirectUri =
    askClient && id && typeof window !== "undefined"
      ? remoteMcpRedirectUri(window.location.origin, id)
      : null;
  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>{COPY.title}</DialogTitle>
        <DialogDescription>{COPY.description}</DialogDescription>
      </DialogHeader>
      <FormField id={ids.url} label={COPY.urlLabel} error={shown.url}>
        {(describedBy) => (
          <Input
            id={ids.url}
            type="url"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder={COPY.urlPlaceholder}
            value={state.url}
            aria-invalid={shown.url ? true : undefined}
            aria-describedby={describedBy}
            onChange={(event) => set({ url: event.target.value })}
          />
        )}
      </FormField>
      <FormField
        id={ids.name}
        label={COPY.nameLabel}
        help={COPY.nameHelp}
        error={shown.name}
      >
        {(describedBy) => (
          <Input
            id={ids.name}
            autoComplete="off"
            spellCheck={false}
            placeholder={remoteMcpIdFromUrl(state.url.trim()) ?? ""}
            value={state.name}
            aria-invalid={shown.name ? true : undefined}
            aria-describedby={describedBy}
            onChange={(event) => set({ name: event.target.value })}
          />
        )}
      </FormField>
      <FormField
        id={ids.kind}
        label={COPY.credentialLabel}
        help={credentialHelp}
      >
        {(describedBy) => (
          <ChoiceSelect
            id={ids.kind}
            describedBy={describedBy}
            value={state.kind}
            items={COPY.credentialItems}
            onValueChange={(kind) => set({ kind })}
          />
        )}
      </FormField>
      {state.kind === "header" ? (
        <FormField
          id={ids.header}
          label={COPY.headerLabel}
          error={shown.header}
        >
          {(describedBy) => (
            <Input
              id={ids.header}
              autoComplete="off"
              spellCheck={false}
              placeholder={COPY.headerPlaceholder}
              value={state.header}
              aria-invalid={shown.header ? true : undefined}
              aria-describedby={describedBy}
              onChange={(event) => set({ header: event.target.value })}
            />
          )}
        </FormField>
      ) : null}
      {state.kind === "header" ? (
        <FormField
          id={ids.prefix}
          label={COPY.prefixLabel}
          help={COPY.prefixHelp}
        >
          {(describedBy) => (
            <Input
              id={ids.prefix}
              autoComplete="off"
              spellCheck={false}
              maxLength={32}
              value={state.prefix}
              aria-describedby={describedBy}
              onChange={(event) => set({ prefix: event.target.value })}
            />
          )}
        </FormField>
      ) : null}
      {state.kind === "query" ? (
        <FormField id={ids.param} label={COPY.paramLabel} error={shown.param}>
          {(describedBy) => (
            <Input
              id={ids.param}
              autoComplete="off"
              spellCheck={false}
              placeholder={COPY.paramPlaceholder}
              value={state.param}
              aria-invalid={shown.param ? true : undefined}
              aria-describedby={describedBy}
              onChange={(event) => set({ param: event.target.value })}
            />
          )}
        </FormField>
      ) : null}
      {state.kind === "provider" ? (
        <FormField
          id={ids.provider}
          label={COPY.providerLabel}
          help={
            providers === null
              ? COPY.providersLoading
              : providers.length === 0
                ? COPY.providersNone
                : undefined
          }
          error={shown.provider}
        >
          {(describedBy) => (
            <ChoiceSelect
              id={ids.provider}
              describedBy={describedBy}
              value={state.provider}
              items={(providers ?? []).map((provider) => ({
                value: provider.id,
                label: `${provider.name} (${provider.id})`,
              }))}
              onValueChange={(provider) => set({ provider })}
            />
          )}
        </FormField>
      ) : null}
      {state.kind === "oauth" && askClient ? (
        <>
          <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
            <li>
              {COPY.clientRegisterStep}
              {redirectUri ? (
                <div className="mt-2 -ml-5">
                  <CodeBlock
                    code={redirectUri}
                    successMessage="Redirect URI copied"
                  />
                </div>
              ) : null}
            </li>
            <li>{COPY.clientPasteStep}</li>
          </ol>
          <FormField
            id={ids.clientId}
            label={COPY.clientIdLabel}
            error={shown.clientId}
          >
            {(describedBy) => (
              <Input
                id={ids.clientId}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                value={state.clientId}
                aria-invalid={shown.clientId ? true : undefined}
                aria-describedby={describedBy}
                onChange={(event) => set({ clientId: event.target.value })}
              />
            )}
          </FormField>
          <FormField id={ids.clientSecret} label={COPY.clientSecretLabel}>
            {(describedBy) => (
              <Input
                id={ids.clientSecret}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={state.clientSecret}
                aria-describedby={describedBy}
                onChange={(event) => set({ clientSecret: event.target.value })}
              />
            )}
          </FormField>
        </>
      ) : null}
      <FormField id={ids.risk} label={COPY.riskLabel} help={riskHelp?.help}>
        {(describedBy) => (
          <ChoiceSelect
            id={ids.risk}
            describedBy={describedBy}
            value={state.risk}
            items={COPY.riskItems}
            onValueChange={(risk) => set({ risk })}
          />
        )}
      </FormField>
      {serverError ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{serverError}</AlertDescription>
        </Alert>
      ) : null}
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>
          Close
        </DialogClose>
        <Button type="submit" pending={pending}>
          {COPY.submit}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** A label, the control, its help and its error, wired by id. */
function FormField({
  id,
  label,
  help,
  error,
  children,
}: {
  id: string;
  label: string;
  help?: string;
  error?: string | null;
  children: (describedBy: string | undefined) => ReactNode;
}) {
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {children(describedBy)}
      {help ? <FieldDescription id={helpId}>{help}</FieldDescription> : null}
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </Field>
  );
}

/**
 * What to do once the Gateway added the server: set its key (the
 * operator's command), connect an account (OAuth), or nothing, with how
 * many tools are on /mcp.
 */
function AddedMcpServer({ added }: { added: AddedRemoteMcpApp }) {
  const copy = MCP_APP_COPY.added;
  if (added.setupCommand) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{copy.credentialTitle(added.name)}</DialogTitle>
          <DialogDescription>{copy.credentialIntro}</DialogDescription>
        </DialogHeader>
        <CodeBlock code={added.setupCommand} successMessage="Command copied" />
        <DialogFooter showCloseButton />
      </>
    );
  }
  if (added.connectPath) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{copy.connectTitle(added.name)}</DialogTitle>
          <DialogDescription>{copy.connectIntro}</DialogDescription>
        </DialogHeader>
        <DialogFooter showCloseButton>
          <Button nativeButton={false} render={<a href={added.connectPath} />}>
            {copy.connect}
          </Button>
        </DialogFooter>
      </>
    );
  }
  const line = added.secret
    ? copy.credentialSet
    : added.toolCount && added.toolCount > 0
      ? copy.tools(added.toolCount)
      : added.toolsStatus === "empty"
        ? copy.empty
        : null;
  return (
    <>
      <DialogHeader>
        <DialogTitle>{copy.title(added.name)}</DialogTitle>
        {line ? <DialogDescription>{line}</DialogDescription> : null}
      </DialogHeader>
      <DialogFooter showCloseButton />
    </>
  );
}
