import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, RefreshCw } from "lucide-react";
import {
  remoteToolRisk,
  type RemoteMcpRiskDefault,
  type RemoteMcpToolOverride,
  type ToolRisk,
} from "@every-app/sdk/internal";
import { ChoiceSelect } from "@/client/components/ChoiceSelect";
import { CodeBlock } from "@/client/components/CodeBlock";
import { ErrorState } from "@/client/components/ErrorState";
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
import { Field, FieldError, FieldLabel } from "@/client/components/ui/field";
import { Input } from "@/client/components/ui/input";
import { Separator } from "@/client/components/ui/separator";
import { Skeleton } from "@/client/components/ui/skeleton";
import { Switch } from "@/client/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/client/components/ui/table";
import { Textarea } from "@/client/components/ui/textarea";
import { getRuleErrorMessage } from "@/client/errors";
import { MCP_APP_COPY } from "@/client/lib/mcpAppCopy";
import {
  getMcpApp,
  refreshMcpAppTools,
  setMcpAppStatus,
  updateRemoteMcpApp,
} from "@/serverFunctions/mcpApps";
import type {
  McpAppDetails,
  McpAppTool,
  RefreshedMcpAppTools,
  RemoteToolRiskHint,
} from "@/types/mcpApp";

const COPY = MCP_APP_COPY.edit;

/** The per-tool risk select's value: no override, or one. */
type ToolRiskChoice = "default" | ToolRisk;

type Overrides = Record<string, RemoteMcpToolOverride>;

interface McpAppEditDialogProps {
  /** The Apps table's row: its id and what to show while the app loads. */
  app: { id: string; name: string; appId: string };
  onClose: () => void;
  /** Something the Apps table shows changed (status, name): it reads again. */
  onChanged?: () => void;
}

/** The query key of one MCP app's details. */
function mcpAppQueryKey(id: string) {
  return ["admin", "mcp-app", id] as const;
}

/**
 * A remote MCP app, edited in place (Admin → Apps → Edit): the server's
 * URL and auth (fixed: a server elsewhere is another app), where its
 * credential stands, status with Turn on/off, Refresh tools, the risk
 * default, and every tool the server listed with its risk (a per-tool
 * select over the app's default, the effective risk and where it comes
 * from beside it) and an on/off switch; then the name and description.
 * Save sends what changed. Render it only while it is open.
 */
export function McpAppEditDialog({
  app,
  onClose,
  onChanged,
}: McpAppEditDialogProps) {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: mcpAppQueryKey(app.id),
    queryFn: () => getMcpApp({ data: { id: app.id } }),
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-2xl">
        {data ? (
          <McpAppEditForm
            details={data}
            onClose={onClose}
            onChanged={() => {
              onChanged?.();
              void refetch();
            }}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{COPY.title(app.name)}</DialogTitle>
              <DialogDescription>
                {COPY.description(app.appId)}
              </DialogDescription>
            </DialogHeader>
            {isError ? (
              <ErrorState
                message={COPY.loadFailed}
                onRetry={() => void refetch()}
              />
            ) : isLoading ? (
              <div className="flex flex-col gap-3" aria-busy>
                <Skeleton className="h-5 w-2/3" />
                <Skeleton className="h-5 w-1/2" />
                <Skeleton className="h-24 w-full" />
              </div>
            ) : null}
            <DialogFooter showCloseButton />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The hints a stored risk hint stands for, as the rule reads them. */
function hintsOf(hint: RemoteToolRiskHint) {
  if (hint === "read") return { readOnlyHint: true };
  if (hint === "destructive") return { destructiveHint: true };
  return undefined;
}

/** The override map as stored: no empty entries, no `enabled: true`. */
function cleanOverrides(overrides: Overrides): Overrides {
  const out: Overrides = {};
  for (const [name, override] of Object.entries(overrides)) {
    const kept: RemoteMcpToolOverride = {};
    if (override.risk) kept.risk = override.risk;
    if (override.enabled === false) kept.enabled = false;
    if (Object.keys(kept).length > 0) out[name] = kept;
  }
  return out;
}

function sameOverrides(a: Overrides, b: Overrides): boolean {
  const left = cleanOverrides(a);
  const right = cleanOverrides(b);
  const names = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const name of names) {
    if (
      left[name]?.risk !== right[name]?.risk ||
      left[name]?.enabled !== right[name]?.enabled
    ) {
      return false;
    }
  }
  return true;
}

function McpAppEditForm({
  details,
  onClose,
  onChanged,
}: {
  details: McpAppDetails;
  onClose: () => void;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const remote = details.remote;
  const original = {
    name: details.name,
    description: details.description,
    risk: (remote?.risk ?? "annotations") as RemoteMcpRiskDefault,
    tools: remote?.tools ?? {},
  };
  const [name, setName] = useState(original.name);
  const [description, setDescription] = useState(original.description);
  const [risk, setRisk] = useState<RemoteMcpRiskDefault>(original.risk);
  const [overrides, setOverrides] = useState<Overrides>(original.tools);
  const [saving, setSaving] = useState(false);
  const [statusPending, setStatusPending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshed, setRefreshed] = useState<RefreshedMcpAppTools | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ids = { name: useId(), description: useId(), risk: useId() };
  const nameProblem = name.trim() ? null : "Name is required";

  const setOverride = (tool: string, change: RemoteMcpToolOverride) => {
    setOverrides((current) => ({
      ...current,
      [tool]: { ...current[tool], ...change },
    }));
  };

  const toggleStatus = async () => {
    setStatusPending(true);
    setError(null);
    try {
      await setMcpAppStatus({
        data: {
          id: details.id,
          status: details.status === "active" ? "disabled" : "active",
        },
      });
      onChanged();
    } catch (caught) {
      setError(getRuleErrorMessage(caught, COPY.saveFailed));
    } finally {
      setStatusPending(false);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      setRefreshed(await refreshMcpAppTools({ data: { id: details.id } }));
      onChanged();
    } catch (caught) {
      setError(getRuleErrorMessage(caught, COPY.saveFailed));
    } finally {
      setRefreshing(false);
    }
  };

  const save = async () => {
    if (nameProblem) return;
    const change = {
      ...(name.trim() !== original.name ? { name: name.trim() } : {}),
      ...(description.trim() !== original.description
        ? { description: description.trim() }
        : {}),
      ...(risk !== original.risk ? { risk } : {}),
      ...(!sameOverrides(overrides, original.tools)
        ? { tools: cleanOverrides(overrides) }
        : {}),
    };
    if (Object.keys(change).length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateRemoteMcpApp({ data: { id: details.id, ...change } });
      await queryClient.invalidateQueries({
        queryKey: mcpAppQueryKey(details.id),
      });
      onChanged();
      onClose();
    } catch (caught) {
      setError(getRuleErrorMessage(caught, COPY.saveFailed));
    } finally {
      setSaving(false);
    }
  };

  const credential = details.credential;
  const on = details.status === "active";
  const block = { risk, tools: overrides };
  const effectiveOf = (tool: McpAppTool) =>
    remoteToolRisk(hintsOf(tool.riskHint), block, tool.upstreamName);
  const anyDestructive = details.tools.some(
    (tool) => effectiveOf(tool).risk === "destructive",
  );
  const riskHelp = COPY.riskItems.find((item) => item.value === risk)?.help;
  const toolRiskItems: { value: ToolRiskChoice; label: string }[] = [
    { value: "default", label: COPY.toolRiskNone(risk) },
    ...COPY.toolRiskItems,
  ];

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <DialogHeader>
        <DialogTitle>{COPY.title(details.name)}</DialogTitle>
        <DialogDescription>{COPY.description(details.appId)}</DialogDescription>
      </DialogHeader>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        <dt className="font-medium">{COPY.serverLabel}</dt>
        <dd className="min-w-0">
          <span className="font-mono text-xs break-all">{remote?.url}</span>
          {details.authLabel ? (
            <span className="text-muted-foreground">
              {" "}
              · {details.authLabel}
            </span>
          ) : null}
        </dd>
        <dt className="font-medium">{COPY.credentialLabel}</dt>
        <dd className="flex min-w-0 flex-col gap-2" data-testid="credential">
          <span className="text-muted-foreground">
            {credential ? credentialLine(credential) : null}
          </span>
          {details.setupCommand ? (
            <CodeBlock
              code={details.setupCommand}
              successMessage="Command copied"
            />
          ) : null}
        </dd>
        <dt className="font-medium">{COPY.statusLabel}</dt>
        <dd className="flex flex-wrap items-center gap-3">
          <span className="text-muted-foreground">
            {on ? COPY.on : COPY.off}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            pending={statusPending}
            onClick={() => void toggleStatus()}
          >
            {on ? COPY.turnOff : COPY.turnOn}
          </Button>
        </dd>
      </dl>

      <Separator />

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            <p className="text-sm font-medium">{COPY.toolsLabel}</p>
            <p className="text-xs text-muted-foreground">
              {details.snapshot.fetchedAt
                ? COPY.lastListed(
                    new Date(details.snapshot.fetchedAt).toLocaleString(),
                  )
                : COPY.neverListed}
              {details.snapshot.lastError
                ? ` ${COPY.listingFailed(details.snapshot.lastError)}`
                : ""}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            pending={refreshing}
            onClick={() => void refresh()}
          >
            {refreshing ? null : <RefreshCw data-icon="inline-start" />}
            {COPY.refresh}
          </Button>
        </div>
        {refreshed ? (
          <p role="status" className="text-xs text-muted-foreground">
            {[
              refreshed.added.length ? COPY.refreshAdded(refreshed.added) : "",
              refreshed.removed.length
                ? COPY.refreshRemoved(refreshed.removed)
                : "",
              !refreshed.added.length && !refreshed.removed.length
                ? COPY.refreshNoChange
                : "",
              refreshed.error ?? "",
            ]
              .filter(Boolean)
              .join(" ")}
          </p>
        ) : null}

        <Field>
          <FieldLabel htmlFor={ids.risk}>{COPY.riskLabel}</FieldLabel>
          <ChoiceSelect
            id={ids.risk}
            describedBy={`${ids.risk}-help`}
            value={risk}
            items={COPY.riskItems}
            onValueChange={setRisk}
            className="w-full sm:w-72"
          />
          <p id={`${ids.risk}-help`} className="text-xs text-muted-foreground">
            {riskHelp}
          </p>
        </Field>

        {details.tools.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {credential?.state === "not_set" ||
            credential?.state === "bound_elsewhere"
              ? COPY.noToolsNeedsCredential
              : COPY.noTools}
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{COPY.columns.name}</TableHead>
                  <TableHead>{COPY.columns.serverName}</TableHead>
                  <TableHead>{COPY.columns.risk}</TableHead>
                  <TableHead className="w-12">{COPY.columns.on}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {details.tools.map((tool) => {
                  const effective = effectiveOf(tool);
                  const choice: ToolRiskChoice =
                    overrides[tool.upstreamName]?.risk ?? "default";
                  const enabled =
                    overrides[tool.upstreamName]?.enabled !== false;
                  return (
                    <TableRow
                      key={tool.upstreamName}
                      data-tool={tool.upstreamName}
                    >
                      <TableCell className="align-top">
                        {tool.listedName ? (
                          <span className="font-mono text-xs break-all">
                            {tool.listedName}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {COPY.notListed}
                          </span>
                        )}
                        {tool.title ? (
                          <span className="block text-xs text-muted-foreground">
                            {tool.title}
                          </span>
                        ) : null}
                        {!tool.listed && tool.problem ? (
                          <span className="block text-xs text-muted-foreground italic">
                            {tool.problem}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="align-top font-mono text-xs break-all">
                        {tool.upstreamName}
                      </TableCell>
                      <TableCell className="align-top">
                        <ChoiceSelect<ToolRiskChoice>
                          size="sm"
                          className="w-40"
                          label={COPY.toolRiskLabel(tool.upstreamName)}
                          value={choice}
                          items={toolRiskItems}
                          onValueChange={(next) =>
                            setOverride(tool.upstreamName, {
                              risk: next === "default" ? undefined : next,
                            })
                          }
                        />
                        <span
                          className="mt-1 block text-xs text-muted-foreground"
                          data-testid="effective-risk"
                        >
                          {COPY.effective(effective.risk, effective.source)}
                        </span>
                      </TableCell>
                      <TableCell className="align-top">
                        <Switch
                          aria-label={COPY.toolSwitchLabel(tool.upstreamName)}
                          checked={enabled}
                          onCheckedChange={(checked) =>
                            setOverride(tool.upstreamName, {
                              enabled: checked ? undefined : false,
                            })
                          }
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
        {anyDestructive ? (
          <p className="text-xs text-muted-foreground">
            {COPY.destructiveNote}
          </p>
        ) : null}
      </div>

      <Separator />

      <Field data-invalid={nameProblem ? true : undefined}>
        <FieldLabel htmlFor={ids.name}>{COPY.nameLabel}</FieldLabel>
        <Input
          id={ids.name}
          value={name}
          maxLength={255}
          aria-invalid={nameProblem ? true : undefined}
          onChange={(event) => setName(event.target.value)}
        />
        {nameProblem ? <FieldError>{nameProblem}</FieldError> : null}
      </Field>
      <Field>
        <FieldLabel htmlFor={ids.description}>
          {COPY.descriptionLabel}
        </FieldLabel>
        <Textarea
          id={ids.description}
          value={description}
          maxLength={1000}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Field>

      {error ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          {COPY.cancel}
        </Button>
        <Button type="submit" pending={saving}>
          {COPY.save}
        </Button>
      </DialogFooter>
    </form>
  );
}

function credentialLine(credential: NonNullable<McpAppDetails["credential"]>) {
  const copy = COPY.credential;
  const name = credential.name ?? "";
  switch (credential.state) {
    case "none":
      return copy.none;
    case "unsupported":
      return copy.unsupported;
    case "not_set":
      return copy.not_set(name);
    case "set":
      return copy.set(name);
    case "bound":
      return copy.bound(name, credential.boundTo ?? "");
    case "bound_elsewhere":
      return copy.bound_elsewhere(name);
  }
}
