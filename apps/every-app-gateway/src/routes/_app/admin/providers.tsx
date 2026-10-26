import { Component, useMemo, useState, type ReactNode } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
  KeyRound,
  Link2,
  ListChecks,
  Plus,
  Trash2,
  Unplug,
} from "lucide-react";
import { toast } from "sonner";
import { AddOAuthProviderDialog } from "@/client/components/admin/AddOAuthProviderDialog";
import { ReplaceOAuthClientDialog } from "@/client/components/admin/ReplaceOAuthClientDialog";
import { ScopeSetsDialog } from "@/client/components/admin/ScopeSetsDialog";
import { CodeBlock } from "@/client/components/CodeBlock";
import { ConfirmDialog } from "@/client/components/ConfirmDialog";
import { ErrorState } from "@/client/components/ErrorState";
import { SectionHeader } from "@/client/components/PageHeader";
import { RowActionsMenu } from "@/client/components/RowActionsMenu";
import { DataTable, useDataTable } from "@/client/components/table/DataTable";
import { DateCell, dateSortValue } from "@/client/components/table/DateCell";
import { SortableHeader } from "@/client/components/table/SortableHeader";
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
import { DropdownMenuItem } from "@/client/components/ui/dropdown-menu";
import { Input } from "@/client/components/ui/input";
import { Skeleton } from "@/client/components/ui/skeleton";
import { getRuleErrorMessage } from "@/client/errors";
import {
  clientSourceLabel,
  connectPathFor,
  scopeSetsText,
} from "@/client/lib/oauthProviders";
import { getAiDefault } from "@/serverFunctions/ai";
import {
  disconnectConnection,
  listAllConnections,
} from "@/serverFunctions/connections";
import {
  addOAuthProvider,
  addScopeSet,
  listProviders,
  removeOAuthClient,
  removeProvider,
  removeScopeSet,
  setOAuthClient,
} from "@/serverFunctions/providers";

export const Route = createFileRoute("/_app/admin/providers")({
  component: ProvidersPage,
});

const PROVIDERS_KEY = ["admin", "providers"] as const;
const CONNECTIONS_KEY = ["admin", "providerConnections"] as const;
const AI_DEFAULT_KEY = ["admin", "ai-default"] as const;

type Provider = Awaited<ReturnType<typeof listProviders>>["providers"][number];
type OAuthProvider = NonNullable<Provider["oauth"]>;
type Connection = Awaited<
  ReturnType<typeof listAllConnections>
>["connections"][number];

const KIND_LABEL: Record<Provider["kind"], string> = {
  api_key: "API key",
  oauth: "OAuth",
  ai: "AI",
  service: "Gateway service",
};

/** The same path the callback returns to after "Connect for the organization". */
const ADMIN_RETURN_PATH = "/admin/providers";

/** The user docs' provider pages: where to get a key. */
const PROVIDER_DOCS_URL = "https://everyapp.com/docs/providers";

/** A provider's page: one per company, as packages/cli/src/docs/providerGuides.ts (COMPANY_OF) names them. */
const DOCS_PAGE_OF: Readonly<Record<string, string>> = {
  "google-workspace": "google",
  "microsoft-365": "microsoft",
  "turso-db": "turso",
  "tiktok-business": "tiktok",
};

function providerDocsUrl(id: string): string {
  return `${PROVIDER_DOCS_URL}/${DOCS_PAGE_OF[id] ?? id.replace(/-oauth$/, "")}`;
}

/**
 * A row as this page reads it. A list from an older Gateway build (before
 * `configured`, `settings` and `apps`, as a cache restored from the browser
 * can be) reads as not set up and listed by no app, instead of throwing
 * and blanking the tab.
 */
function readProvider(provider: Provider): Provider {
  const row = provider as Partial<Provider> & Pick<Provider, "id">;
  return {
    ...provider,
    name: row.name ?? provider.id,
    hosts: Array.isArray(row.hosts) ? row.hosts : [],
    configured: row.configured === true,
    settings: Array.isArray(row.settings) ? row.settings : [],
    apps: Array.isArray(row.apps) ? row.apps : [],
  };
}

function readProviders(data: { providers: Provider[] }): {
  providers: Provider[];
} {
  return {
    providers: Array.isArray(data.providers)
      ? data.providers.map(readProvider)
      : [],
  };
}

/** One row failing to render shows its name and a line instead of the tab's error page. */
class ProviderBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function BrokenProviderRow({ provider }: { provider: Provider }) {
  return (
    <li className="px-4 py-3">
      <p className="truncate text-sm font-medium">{provider.name}</p>
      <p className="text-xs text-muted-foreground">
        Couldn't show this provider. Reload the page to try again.
      </p>
    </li>
  );
}

/** What a provider still lacks, in the words its Set up action answers. */
function needLabel(provider: Provider): string {
  return provider.kind === "oauth" ? "Needs a client" : "Needs a key";
}

function ProviderStatus({ provider }: { provider: Provider }) {
  return provider.configured ? (
    <Badge variant="success">Ready</Badge>
  ) : (
    <span className="text-xs text-muted-foreground">Not set</span>
  );
}

/**
 * How the page groups the list: what is set up (or registered here),
 * what an installed app needs and lacks, and the rest of the catalog
 * behind Show all. Gateway services (email, members) are internals and
 * never list.
 */
function partitionProviders(providers: readonly Provider[]): {
  setUp: Provider[];
  needed: Provider[];
  rest: Provider[];
  listed: Provider[];
} {
  const listed = providers.filter((provider) => provider.kind !== "service");
  const setUp: Provider[] = [];
  const needed: Provider[] = [];
  const rest: Provider[] = [];
  for (const provider of listed) {
    if (provider.configured || provider.source === "row") setUp.push(provider);
    else if (provider.apps.some((app) => app.needs)) needed.push(provider);
    else rest.push(provider);
  }
  return { setUp, needed, rest, listed };
}

/** "AI models, APIs, OAuth sign-ins": the kinds among `providers`, in that order. */
function kindsLine(providers: readonly Provider[]): string {
  const words: [Provider["kind"], string][] = [
    ["ai", "AI models"],
    ["api_key", "APIs"],
    ["oauth", "OAuth sign-ins"],
  ];
  return words
    .filter(([kind]) => providers.some((provider) => provider.kind === kind))
    .map(([, word]) => word)
    .join(", ");
}

/** The muted line under a provider's name: its kind, then what is known about its use. */
function providerDetail(
  provider: Provider,
  options: { aiDefault: string | null; needing?: boolean },
): string {
  const parts = [KIND_LABEL[provider.kind]];
  if (provider.source === "row") parts.push("registered here");
  if (provider.id === options.aiDefault) parts.push("AI default");
  const connections = provider.oauth?.connections ?? 0;
  if (connections > 0) {
    parts.push(`${connections} connection${connections === 1 ? "" : "s"}`);
  }
  const apps = provider.apps
    .filter((app) => !options.needing || app.needs)
    .map((app) => app.name);
  if (apps.length > 0) {
    parts.push(
      `${options.needing ? "needed by" : "used by"} ${apps.join(", ")}`,
    );
  }
  return parts.join(" · ");
}

function ProviderRow({
  provider,
  detail,
  status,
  action,
}: {
  provider: Provider;
  detail: string;
  status: ReactNode;
  action: ReactNode;
}) {
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0 space-y-0.5">
        <p className="truncate text-sm font-medium">{provider.name}</p>
        <p className="truncate text-xs text-muted-foreground">{detail}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2 text-sm">
        {status}
        {action}
      </div>
    </li>
  );
}

function ProviderGroup({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">
        {title} <span className="text-muted-foreground">· {count}</span>
      </h3>
      <ul
        className="divide-y divide-border rounded-lg border border-border"
        aria-label={title}
      >
        {children}
      </ul>
    </div>
  );
}

/** How a key is set: from the terminal, by name; the value never passes through the browser. */
function SetKeyDialog({
  provider,
  onClose,
}: {
  provider: Provider;
  onClose: () => void;
}) {
  const needing = provider.apps
    .filter((app) => app.needs)
    .map((app) => app.name);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Set up {provider.name}</DialogTitle>
          <DialogDescription>
            {needing.length > 0 ? `${needing.join(", ")} needs it. ` : null}
            Keys are set from the terminal, so the value never passes through
            the browser.
          </DialogDescription>
        </DialogHeader>
        <CodeBlock
          code={`pnpm everyapp secret set ${provider.settings.join(" ")}`}
          successMessage="Command copied"
        />
        <p className="text-xs text-muted-foreground">
          Where to get the key:{" "}
          <a
            className="underline underline-offset-4 hover:text-foreground"
            href={providerDocsUrl(provider.id)}
            target="_blank"
            rel="noreferrer"
          >
            the {provider.name} page
          </a>
          .
        </p>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}

interface ProviderActionHandlers {
  onReplaceClient: (provider: OAuthProvider) => void;
  onForgetClient: (provider: OAuthProvider) => void;
  /** A built-in client's scope sets: the client's own and the ones added here. */
  onScopeSets: (provider: Provider) => void;
  onRemove: (provider: Provider) => void;
}

/** A provider's menu: its client for an OAuth one, Scope sets for a built-in client with sets, Remove for a registered row; none for a built-in key. */
function ProviderActions({
  provider,
  onReplaceClient,
  onForgetClient,
  onScopeSets,
  onRemove,
}: { provider: Provider } & ProviderActionHandlers) {
  const entry = provider.oauth;
  if (!entry && provider.source === "catalog") return null;
  return (
    <RowActionsMenu label={`Actions for ${provider.name}`}>
      {entry ? (
        <DropdownMenuItem onClick={() => onReplaceClient(entry)}>
          <KeyRound />
          {entry.client.source ? "Replace client" : "Set client"}
        </DropdownMenuItem>
      ) : null}
      {entry?.client.source === "d1" ? (
        <DropdownMenuItem onClick={() => onForgetClient(entry)}>
          <Unplug />
          Forget pasted client
        </DropdownMenuItem>
      ) : null}
      {entry && provider.source === "catalog" && entry.scopeSets.length > 0 ? (
        <DropdownMenuItem onClick={() => onScopeSets(provider)}>
          <ListChecks />
          Scope sets
        </DropdownMenuItem>
      ) : null}
      {entry?.client.source ? (
        <DropdownMenuItem
          render={
            <a
              href={connectPathFor(entry.id, {
                account: "organization",
                returnTo: ADMIN_RETURN_PATH,
              })}
            />
          }
        >
          <Link2 />
          Connect for the organization
        </DropdownMenuItem>
      ) : null}
      {provider.source === "row" ? (
        <DropdownMenuItem
          variant="destructive"
          onClick={() => onRemove(provider)}
        >
          <Trash2 />
          Remove provider
        </DropdownMenuItem>
      ) : null}
    </RowActionsMenu>
  );
}

function providerColumns(
  actions: ProviderActionHandlers,
): ColumnDef<Provider>[] {
  return [
    {
      accessorKey: "name",
      header: ({ column }) => (
        <SortableHeader column={column} label="Provider" />
      ),
      meta: { label: "Provider", cellClassName: "max-w-[260px]" },
      cell: ({ row: { original: provider } }) => (
        <>
          <p className="truncate font-medium">{provider.name}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {provider.id}
          </p>
        </>
      ),
    },
    {
      accessorKey: "kind",
      header: ({ column }) => <SortableHeader column={column} label="Kind" />,
      meta: { label: "Kind" },
      cell: ({ row: { original: provider } }) => (
        <Badge variant="secondary">{KIND_LABEL[provider.kind]}</Badge>
      ),
    },
    {
      id: "status",
      accessorFn: (provider) => (provider.configured ? 0 : 1),
      header: ({ column }) => <SortableHeader column={column} label="Status" />,
      meta: { label: "Status" },
      cell: ({ row: { original: provider } }) => (
        <ProviderStatus provider={provider} />
      ),
    },
    {
      accessorKey: "source",
      header: ({ column }) => <SortableHeader column={column} label="Source" />,
      meta: { label: "Source", cellClassName: "text-xs text-muted-foreground" },
      cell: ({ row: { original: provider } }) =>
        provider.source === "catalog" ? "Built in" : "Registered here",
    },
    {
      id: "client",
      header: "OAuth client",
      enableSorting: false,
      cell: ({ row: { original: provider } }) => {
        const entry = provider.oauth;
        if (!entry) {
          return (
            <span className="text-xs text-muted-foreground">
              {provider.kind === "service" ? "—" : provider.hosts.join(", ")}
            </span>
          );
        }
        const view = clientSourceLabel(entry.client);
        return (
          <span
            className={view.tone === "unset" ? "text-muted-foreground" : ""}
          >
            {view.label}
            {entry.client.stale ? (
              <Badge variant="warning" size="sm" className="ml-2">
                Pasted for other endpoints
              </Badge>
            ) : null}
          </span>
        );
      },
    },
    {
      id: "connections",
      accessorFn: (provider) => provider.oauth?.connections ?? -1,
      header: ({ column }) => (
        <SortableHeader column={column} label="Connections" />
      ),
      meta: { label: "Connections" },
      cell: ({ row: { original: provider } }) =>
        provider.oauth ? provider.oauth.connections : "—",
    },
    {
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      enableSorting: false,
      meta: { headerClassName: "w-10" },
      cell: ({ row: { original: provider } }) => (
        <ProviderActions provider={provider} {...actions} />
      ),
    },
  ];
}

function connectionColumns({
  onDisconnect,
  isDisconnecting,
}: {
  onDisconnect: (connection: Connection) => void;
  isDisconnecting: boolean;
}): ColumnDef<Connection>[] {
  return [
    {
      id: "who",
      accessorFn: (connection) =>
        connection.account === "organization"
          ? "Organization"
          : (connection.userEmail ?? connection.userId ?? ""),
      header: ({ column }) => <SortableHeader column={column} label="Who" />,
      meta: { label: "Who", cellClassName: "max-w-[240px]" },
      cell: ({ row: { original: connection } }) => (
        <>
          <p className="truncate font-medium">
            {connection.account === "organization"
              ? "The organization"
              : (connection.userEmail ?? connection.userId)}
          </p>
          {connection.label ? (
            <p className="truncate text-xs text-muted-foreground">
              {connection.label}
            </p>
          ) : null}
        </>
      ),
    },
    {
      accessorKey: "providerName",
      header: ({ column }) => (
        <SortableHeader column={column} label="Provider" />
      ),
      meta: { label: "Provider" },
    },
    {
      id: "scopeSets",
      header: "Scope sets",
      enableSorting: false,
      meta: { cellClassName: "font-mono text-xs text-muted-foreground" },
      cell: ({ row: { original: connection } }) =>
        scopeSetsText(connection.scopeSets),
    },
    {
      accessorKey: "status",
      header: "Status",
      enableSorting: false,
      cell: ({ row: { original: connection } }) =>
        connection.status === "expired" ? (
          <Badge variant="warning">Needs reconnecting</Badge>
        ) : (
          <Badge variant="success">Connected</Badge>
        ),
    },
    {
      id: "lastUsedAt",
      accessorFn: (connection) => dateSortValue(connection.lastUsedAt, 0),
      header: ({ column }) => (
        <SortableHeader column={column} label="Last used" />
      ),
      meta: {
        label: "Last used",
        cellClassName: "text-xs text-muted-foreground",
      },
      cell: ({ row: { original: connection } }) => (
        <DateCell value={connection.lastUsedAt} />
      ),
    },
    {
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      enableSorting: false,
      meta: { headerClassName: "w-10" },
      cell: ({ row: { original: connection } }) => (
        <RowActionsMenu
          label={`Actions for ${connection.providerName} connection`}
        >
          <DropdownMenuItem
            variant="destructive"
            disabled={isDisconnecting}
            onClick={() => onDisconnect(connection)}
          >
            <Unplug />
            Disconnect
          </DropdownMenuItem>
        </RowActionsMenu>
      ),
    },
  ];
}

/**
 * Manage workspace → Providers (docs/design/2026-10-oauth-providers.md
 * section 9): every provider the Gateway brokers, where each one's key or
 * client comes from (never a value), the OAuth ones with their redirect
 * URI and connection count; Add OAuth provider from a preset or a custom
 * spec with the client pasted in; Replace or Forget a client; Remove a
 * registered provider; and every connection in the organization, each
 * disconnectable. Owners and admins.
 */
function ProvidersPage() {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [replacing, setReplacing] = useState<OAuthProvider | null>(null);
  const [forgetting, setForgetting] = useState<OAuthProvider | null>(null);
  const [removing, setRemoving] = useState<Provider | null>(null);
  const [scopeSetsFor, setScopeSetsFor] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<Connection | null>(null);
  const [settingKey, setSettingKey] = useState<Provider | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [search, setSearch] = useState("");

  const providersQuery = useQuery({
    queryKey: PROVIDERS_KEY,
    queryFn: () => listProviders(),
    select: readProviders,
  });
  const connectionsQuery = useQuery({
    queryKey: CONNECTIONS_KEY,
    queryFn: () => listAllConnections(),
  });
  // Only to mark the default model provider; the page reads fine without it.
  const aiDefaultQuery = useQuery({
    queryKey: AI_DEFAULT_KEY,
    queryFn: () => getAiDefault(),
  });
  const aiDefault = aiDefaultQuery.data?.resolution.configured
    ? aiDefaultQuery.data.resolution.provider
    : null;

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: PROVIDERS_KEY }),
      queryClient.invalidateQueries({ queryKey: CONNECTIONS_KEY }),
    ]);
  };

  const addMutation = useMutation({
    mutationFn: addOAuthProvider,
    onSuccess: async (provider) => {
      await refresh();
      setAdding(false);
      toast.success(`${provider.name} added`);
    },
  });
  const replaceMutation = useMutation({
    mutationFn: setOAuthClient,
    onSuccess: async (provider) => {
      await refresh();
      setReplacing(null);
      toast.success(`${provider.name} client saved`);
    },
  });
  const forgetMutation = useMutation({
    mutationFn: removeOAuthClient,
    onSuccess: async () => {
      await refresh();
      toast.success("Pasted client forgotten");
    },
    onError: (error) =>
      toast.error(getRuleErrorMessage(error, "Failed to forget the client")),
  });
  const addScopeSetMutation = useMutation({
    mutationFn: addScopeSet,
    onSuccess: async (provider) => {
      await refresh();
      toast.success(`${provider.name} scope set added`);
    },
  });
  const removeScopeSetMutation = useMutation({
    mutationFn: removeScopeSet,
    onSuccess: async () => {
      await refresh();
      toast.success("Scope set removed");
    },
  });
  const removeMutation = useMutation({
    mutationFn: removeProvider,
    onSuccess: async () => {
      await refresh();
      toast.success("Provider removed");
    },
    onError: (error) =>
      toast.error(getRuleErrorMessage(error, "Failed to remove the provider")),
  });
  const disconnectMutation = useMutation({
    mutationFn: disconnectConnection,
    onSuccess: async () => {
      await refresh();
      toast.success("Disconnected");
    },
    onError: (error) =>
      toast.error(getRuleErrorMessage(error, "Failed to disconnect")),
  });

  const actions: ProviderActionHandlers = useMemo(
    () => ({
      onReplaceClient: setReplacing,
      onForgetClient: setForgetting,
      onScopeSets: (provider) => setScopeSetsFor(provider.id),
      onRemove: setRemoving,
    }),
    [],
  );
  // The dialog reads the provider from the query, so its list refreshes
  // after an add or a remove.
  const scopeSetsProvider =
    providersQuery.data?.providers.find(
      (provider) => provider.id === scopeSetsFor,
    ) ?? null;
  const providerCols = useMemo(() => providerColumns(actions), [actions]);
  const groups = useMemo(
    () => partitionProviders(providersQuery.data?.providers ?? []),
    [providersQuery.data],
  );
  const matching = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return needle
      ? groups.listed.filter(
          (provider) =>
            provider.name.toLowerCase().includes(needle) ||
            provider.id.includes(needle),
        )
      : groups.listed;
  }, [groups.listed, search]);
  const providersTable = useDataTable({
    data: matching,
    columns: providerCols,
    getRowId: (provider) => provider.id,
    withSorting: true,
  });
  const connectionCols = useMemo(
    () =>
      connectionColumns({
        onDisconnect: setDisconnecting,
        isDisconnecting: disconnectMutation.isPending,
      }),
    [disconnectMutation.isPending],
  );
  const connectionsTable = useDataTable({
    data: connectionsQuery.data?.connections ?? [],
    columns: connectionCols,
    getRowId: (connection) => connection.id,
    withSorting: true,
  });

  // A custom provider's redirect URI, before it exists: the same path every
  // provider's is, on the Gateway the presets were listed from.
  const redirectUriFor = (id: string): string => {
    const sample = providersQuery.data?.providers.find(
      (provider) => provider.oauth,
    )?.oauth?.redirectUri;
    const origin = sample
      ? sample.slice(0, sample.indexOf("/connect/"))
      : typeof window === "undefined"
        ? ""
        : window.location.origin;
    return `${origin}/connect/${id}/callback`;
  };

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <SectionHeader
          title="Providers"
          hint="Keys and OAuth clients the Gateway holds for your apps. Never shown back."
          action={
            <Button onClick={() => setAdding(true)}>
              <Plus />
              Add OAuth provider
            </Button>
          }
        />
        {providersQuery.isError ? (
          <ErrorState
            message="Couldn't load the providers."
            onRetry={() => void providersQuery.refetch()}
            isRetrying={providersQuery.isFetching}
          />
        ) : !providersQuery.data ? (
          <div className="space-y-2" aria-busy>
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        ) : (
          <>
            {groups.setUp.length > 0 ? (
              <ProviderGroup title="Set up" count={groups.setUp.length}>
                {groups.setUp.map((provider) => (
                  <ProviderBoundary
                    key={provider.id}
                    fallback={<BrokenProviderRow provider={provider} />}
                  >
                    <ProviderRow
                      provider={provider}
                      detail={providerDetail(provider, { aiDefault })}
                      status={
                        provider.configured ? (
                          <Badge variant="success">Ready</Badge>
                        ) : (
                          <Badge variant="warning">{needLabel(provider)}</Badge>
                        )
                      }
                      action={
                        <ProviderActions provider={provider} {...actions} />
                      }
                    />
                  </ProviderBoundary>
                ))}
              </ProviderGroup>
            ) : (
              <p className="text-sm text-muted-foreground">
                Nothing is set up yet. Set a key from the terminal, or add an
                OAuth provider.
              </p>
            )}

            {groups.needed.length > 0 ? (
              <ProviderGroup
                title="Needed by an app"
                count={groups.needed.length}
              >
                {groups.needed.map((provider) => (
                  <ProviderBoundary
                    key={provider.id}
                    fallback={<BrokenProviderRow provider={provider} />}
                  >
                    <ProviderRow
                      provider={provider}
                      detail={providerDetail(provider, {
                        aiDefault,
                        needing: true,
                      })}
                      status={
                        <Badge variant="warning">{needLabel(provider)}</Badge>
                      }
                      action={
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            provider.oauth
                              ? setReplacing(provider.oauth)
                              : setSettingKey(provider)
                          }
                        >
                          Set up
                        </Button>
                      }
                    />
                  </ProviderBoundary>
                ))}
              </ProviderGroup>
            ) : null}

            {showAll ? (
              <div
                className="space-y-3"
                role="region"
                aria-label="All providers"
              >
                <div className="flex items-center justify-between gap-3">
                  <Input
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search providers"
                    aria-label="Search providers"
                    className="max-w-xs"
                  />
                  <Button variant="ghost" onClick={() => setShowAll(false)}>
                    Hide
                  </Button>
                </div>
                <ProviderBoundary
                  fallback={
                    <p className="text-sm text-muted-foreground">
                      Couldn't show the full list. Reload the page to try again.
                    </p>
                  }
                >
                  <DataTable
                    table={providersTable}
                    isLoading={false}
                    empty={{
                      title: "No providers match",
                      description: "Try another name or id.",
                    }}
                  />
                </ProviderBoundary>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-border px-4 py-3">
                <p className="text-sm text-muted-foreground">
                  {groups.rest.length} more built in
                  {groups.rest.length > 0
                    ? `: ${kindsLine(groups.rest)}`
                    : null}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setShowAll(true)}
                >
                  Show all providers
                </Button>
              </div>
            )}
          </>
        )}
      </section>

      <section className="space-y-4">
        <SectionHeader
          title="Connections"
          hint="Every account connected in this workspace: each person's and the organization's. Disconnecting removes the tokens here and, where the provider allows, revokes them."
        />
        <DataTable
          table={connectionsTable}
          isLoading={connectionsQuery.isLoading}
          error={
            connectionsQuery.isError ? (
              <ErrorState
                message="Couldn't load the connections."
                onRetry={() => void connectionsQuery.refetch()}
                isRetrying={connectionsQuery.isFetching}
              />
            ) : undefined
          }
          empty={{
            title: "No connections yet",
            description:
              "People connect under their account's Connected accounts; the organization's from a provider's menu above.",
          }}
        />
      </section>

      {adding ? (
        <AddOAuthProviderDialog
          redirectUriFor={redirectUriFor}
          onSubmit={async (input) => {
            await addMutation.mutateAsync({ data: input });
          }}
          onClose={() => setAdding(false)}
        />
      ) : null}

      {settingKey ? (
        <SetKeyDialog
          provider={settingKey}
          onClose={() => setSettingKey(null)}
        />
      ) : null}

      {scopeSetsProvider?.oauth ? (
        <ScopeSetsDialog
          provider={{
            id: scopeSetsProvider.id,
            name: scopeSetsProvider.name,
            console: scopeSetsProvider.oauth.console,
            hosts: scopeSetsProvider.hosts,
            scopeSets: scopeSetsProvider.oauth.scopeSets,
          }}
          onAdd={async (input) => {
            await addScopeSetMutation.mutateAsync({ data: input });
          }}
          onRemove={async (name) => {
            await removeScopeSetMutation.mutateAsync({
              data: { providerId: scopeSetsProvider.id, name },
            });
          }}
          onClose={() => setScopeSetsFor(null)}
        />
      ) : null}

      {replacing ? (
        <ReplaceOAuthClientDialog
          provider={{
            id: replacing.id,
            name: replacing.name,
            redirectUri: replacing.redirectUri,
            console: replacing.console,
            clientSource: replacing.client.source,
          }}
          onSubmit={async (client) => {
            await replaceMutation.mutateAsync({
              data: { providerId: replacing.id, ...client },
            });
          }}
          onClose={() => setReplacing(null)}
        />
      ) : null}

      {forgetting ? (
        <ConfirmDialog
          title={`Forget the pasted ${forgetting.name} client?`}
          confirmLabel="Forget client"
          destructive
          pending={forgetMutation.isPending}
          onClose={() => setForgetting(null)}
          onConfirm={() =>
            forgetMutation.mutate(
              { data: { providerId: forgetting.id } },
              { onSettled: () => setForgetting(null) },
            )
          }
        >
          New connections stop until a client is set again; existing tokens keep
          working until they expire.
        </ConfirmDialog>
      ) : null}

      {removing ? (
        <ConfirmDialog
          title={`Remove ${removing.name}?`}
          confirmLabel="Remove provider"
          destructive
          pending={removeMutation.isPending}
          onClose={() => setRemoving(null)}
          onConfirm={() =>
            removeMutation.mutate(
              { data: { providerId: removing.id } },
              { onSettled: () => setRemoving(null) },
            )
          }
        >
          Its client and every connection go with it. Refused while an app lists
          it.
        </ConfirmDialog>
      ) : null}

      {disconnecting ? (
        <ConfirmDialog
          title={`Disconnect ${disconnecting.providerName}?`}
          confirmLabel="Disconnect"
          destructive
          pending={disconnectMutation.isPending}
          onClose={() => setDisconnecting(null)}
          onConfirm={() =>
            disconnectMutation.mutate(
              {
                data: {
                  providerId: disconnecting.providerId,
                  account: disconnecting.account,
                  ...(disconnecting.account === "user" && disconnecting.userId
                    ? { userId: disconnecting.userId }
                    : {}),
                },
              },
              { onSettled: () => setDisconnecting(null) },
            )
          }
        >
          {disconnecting.account === "organization"
            ? "Background work that uses the organization's account stops until someone connects it again."
            : "Apps lose this person's account until they connect again."}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
