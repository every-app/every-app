import { useId, useState, type ReactNode } from "react";
import { ArrowLeft, CircleAlert } from "lucide-react";
import {
  remoteMcpIdFromUrl,
  remoteMcpIdProblem,
  remoteMcpSecretName,
  remoteMcpSecretProblem,
  type RemoteMcpAuthKind,
  type RemoteMcpRiskDefault,
} from "@every-app/sdk/internal";
import { ChoiceSelect } from "@/client/components/ChoiceSelect";
import { CodeBlock } from "@/client/components/CodeBlock";
import { Alert, AlertDescription } from "@/client/components/ui/alert";
import { Button } from "@/client/components/ui/button";
import {
  DialogClose,
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
import { asSentence, getRuleErrorMessage } from "@/client/errors";
import { MCP_APP_COPY } from "@/client/lib/mcpAppCopy";
import { addRemoteMcpApp } from "@/serverFunctions/mcpApps";
import type { AddedRemoteMcpApp } from "@/types/mcpApp";

const COPY = MCP_APP_COPY.addForm;

/** The kinds whose credential is a Gateway setting the operator sets. */
function takesSecret(kind: RemoteMcpAuthKind): boolean {
  return kind === "bearer" || kind === "header" || kind === "basic";
}

/** What the form sends `addRemoteMcpApp`. */
interface AddMcpServerInput {
  url: string;
  id?: string;
  auth: {
    kind: RemoteMcpAuthKind;
    secret?: string;
    header?: string;
  };
  risk: RemoteMcpRiskDefault;
}

interface FormState {
  url: string;
  name: string;
  kind: RemoteMcpAuthKind;
  header: string;
  /** The credential's name as typed, once edited; else it follows the name. */
  secret: string | null;
  risk: RemoteMcpRiskDefault;
}

/** The id the server will settle on: the name given, else the URL's host's. */
function derivedId(state: FormState): string {
  return state.name.trim() || remoteMcpIdFromUrl(state.url.trim()) || "";
}

function secretOf(state: FormState): string {
  if (state.secret !== null) return state.secret.trim();
  const id = derivedId(state);
  return id ? remoteMcpSecretName(id) : "";
}

/** Each field's problem, in the rules' words where the rules have them. */
function problemsOf(state: FormState) {
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
  const headerProblem =
    state.kind === "header" && !state.header.trim() ? COPY.errors.header : null;
  const secretProblem = takesSecret(state.kind)
    ? remoteMcpSecretProblem(secretOf(state))
    : null;
  return {
    url: urlProblem,
    name: nameProblem ? asSentence(nameProblem) : null,
    header: headerProblem,
    secret: secretProblem ? asSentence(secretProblem) : null,
  };
}

/** The form's input for the server function, from what the person entered. */
function addMcpServerInput(state: FormState): AddMcpServerInput {
  const name = state.name.trim();
  return {
    url: state.url.trim(),
    ...(name ? { id: name } : {}),
    auth: takesSecret(state.kind)
      ? {
          kind: state.kind,
          secret: secretOf(state),
          ...(state.kind === "header" ? { header: state.header.trim() } : {}),
        }
      : { kind: state.kind },
    risk: state.risk,
  };
}

/**
 * "Add an MCP server" in the Add app chooser: the form (URL, name,
 * credential, risk default) and, once the Gateway has added it, what to
 * do next: the command that sets the credential for a server that takes
 * one, or how many tools are on /mcp now for one that doesn't. Rendered
 * inside the chooser's dialog, header and footer included.
 */
export function AddMcpServerView({
  onBack,
  onAdded,
}: {
  onBack: () => void;
  /** After the Gateway added it: the lists read it again. */
  onAdded?: (added: AddedRemoteMcpApp) => void;
}) {
  const [state, setState] = useState<FormState>({
    url: "",
    name: "",
    kind: "none",
    header: "",
    secret: null,
    risk: "annotations",
  });
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [added, setAdded] = useState<AddedRemoteMcpApp | null>(null);
  const ids = {
    url: useId(),
    name: useId(),
    kind: useId(),
    header: useId(),
    secret: useId(),
    risk: useId(),
  };

  if (added) return <AddedMcpServer added={added} />;

  const problems = problemsOf(state);
  // A field's problem shows once the form was tried, or, for the
  // credential's name, as soon as it is edited (it is checked as typed).
  const shown = {
    url: attempted ? problems.url : null,
    name: attempted || state.name.trim() ? problems.name : null,
    header: attempted ? problems.header : null,
    secret: attempted || state.secret !== null ? problems.secret : null,
  };
  const id = derivedId(state);
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
      const result = await addRemoteMcpApp({ data: addMcpServerInput(state) });
      setAdded(result);
      onAdded?.(result);
    } catch (error) {
      setServerError(getRuleErrorMessage(error, COPY.errors.failed));
    } finally {
      setPending(false);
    }
  };

  const riskHelp = COPY.riskItems.find((item) => item.value === state.risk);
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
      <FormField
        id={ids.url}
        label={COPY.urlLabel}
        help={COPY.urlHelp}
        error={shown.url}
      >
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
        help={COPY.nameHelp(id)}
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
        help={COPY.credentialHelp[state.kind]}
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
      {takesSecret(state.kind) ? (
        <FormField
          id={ids.secret}
          label={COPY.secretLabel}
          help={COPY.secretHelp}
          error={shown.secret}
        >
          {(describedBy) => (
            <Input
              id={ids.secret}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              value={secretOf(state)}
              aria-invalid={shown.secret ? true : undefined}
              aria-describedby={describedBy}
              onChange={(event) => set({ secret: event.target.value })}
            />
          )}
        </FormField>
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
        <Button
          type="button"
          variant="ghost"
          className="sm:mr-auto"
          onClick={onBack}
        >
          <ArrowLeft data-icon="inline-start" />
          {COPY.back}
        </Button>
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
 * What to do once the Gateway added the server: set its credential (the
 * operator's command), or nothing, with how many tools are on /mcp.
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
        <div className="flex flex-col gap-2">
          <CodeBlock
            code={added.setupCommand}
            successMessage="Command copied"
          />
          <p className="text-xs text-muted-foreground">{copy.operatorNote}</p>
        </div>
        <DialogFooter showCloseButton />
      </>
    );
  }
  const line =
    added.authKind === "oauth"
      ? copy.oauth
      : added.secret
        ? copy.credentialSet(added.secret)
        : added.toolCount && added.toolCount > 0
          ? copy.tools(added.toolCount, added.appId)
          : added.toolsStatus === "empty"
            ? copy.empty
            : copy.firstUse;
  return (
    <>
      <DialogHeader>
        <DialogTitle>{copy.title(added.name)}</DialogTitle>
        <DialogDescription>{line}</DialogDescription>
      </DialogHeader>
      <DialogFooter showCloseButton />
    </>
  );
}
