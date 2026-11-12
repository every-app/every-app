import { Component, useMemo, useState, type ReactNode } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { flexRender, type ColumnDef } from "@tanstack/react-table";
import { ChevronDown, KeyRound, Plus, Trash2, Unplug } from "lucide-react";
import { toast } from "sonner";
import { AddOAuthProviderDialog } from "@/client/components/admin/AddOAuthProviderDialog";
import { ReplaceOAuthClientDialog } from "@/client/components/admin/ReplaceOAuthClientDialog";
import { CodeBlock } from "@/client/components/CodeBlock";
import { ConfirmDialog } from "@/client/components/ConfirmDialog";
import { ConnectionApps } from "@/client/components/ConnectionApps";
import {
  useConnectionRemoval,
  type AppAccess,
} from "@/client/components/ConnectionRemoval";
import { ConnectionStatusBadge } from "@/client/components/ConnectionStatusBadge";
import { ErrorState } from "@/client/components/ErrorState";
import { RowActionsMenu } from "@/client/components/RowActionsMenu";
import {
  SettingsSection,
  SettingsTab,
} from "@/client/components/SettingsLayout";
import {
  CardSlot,
  DataTable,
  useDataTable,
  useInDataTableCard,
} from "@/client/components/table/DataTable";
import {
  DataTableSearch,
  DataTableToolbar,
} from "@/client/components/table/DataTableToolbar";
import {
  DATE_CELL,
  DateCell,
  dateSortValue,
} from "@/client/components/table/DateCell";
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
import { getRuleErrorMessage } from "@/client/errors";
import { clientSourceLabel, scopesText } from "@/client/lib/oauthProviders";
import { getAiDefault } from "@/serverFunctions/ai";
import { listAllConnections } from "@/serverFunctions/connections";
import {
  addOAuthProvider,
  listProviders,
  removeOAuthClient,
  removeProvider,
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

/** Whose connection it is: their email, or their id when no email is known. */
function personOf(connection: Connection): string {
  return connection.userEmail ?? connection.userId;
}

const KIND_LABEL: Record<Provider["kind"], string> = {
  api_key: "API key",
  oauth: "OAuth",
  ai: "AI",
  service: "Gateway service",
};

const SOURCE_LABEL: Record<Provider["source"], string> = {
  catalog: "Built in",
  row: "Registered here",
};

/** The columns that hold a row's controls: the Set up button, then the menu (the id `DataTable` puts top right on a card). */
const SETUP_COLUMN = "setup";
const ACTIONS_COLUMN = "actions";

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

/** A cell failing to render says so in its place instead of the tab's error page. */
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

/**
 * Each cell behind a boundary: a row this build can't fully read keeps its
 * name and the cells that do render, and the rest of the table lists as
 * usual. A menu that fails leaves its place empty.
 */
function guardCells(columns: ColumnDef<Provider>[]): ColumnDef<Provider>[] {
  return columns.map((column) => {
    const { cell } = column;
    if (typeof cell !== "function") return column;
    const fallback =
      column.id === ACTIONS_COLUMN || column.id === SETUP_COLUMN ? null : (
        <span className="text-xs text-muted-foreground">
          Couldn't show this
        </span>
      );
    return {
      ...column,
      cell: (context) => (
        <ProviderBoundary fallback={fallback}>
          {flexRender(cell, context)}
        </ProviderBoundary>
      ),
    };
  });
}

/** Where a provider stands, in the order the table lists them. */
enum ProviderState {
  Ready,
  /**
   * Not set, and waited on: an installed app stays closed without it, or
   * it was registered here (an OAuth preset a deploy registered, until its
   * client is set). These rows carry Set up.
   */
  NeedsSetup,
  NotSet,
}

function providerState(provider: Provider): ProviderState {
  if (provider.configured) return ProviderState.Ready;
  return provider.source === "row" || provider.apps.some((app) => app.needs)
    ? ProviderState.NeedsSetup
    : ProviderState.NotSet;
}

/** A chip in every state, as a connection's status is, so the column reads by color. */
const STATE_BADGE: Record<ProviderState, ReactNode> = {
  [ProviderState.Ready]: <Badge variant="success">Ready</Badge>,
  [ProviderState.NeedsSetup]: <Badge variant="warning">Needs setup</Badge>,
  [ProviderState.NotSet]: <Badge variant="secondary">Not set</Badge>,
};

/**
 * What the table lists before Show all, in its order: what is set up, then
 * what still needs setting up. The rest of the catalog waits behind Show
 * all. Gateway services (email, members) are internals and never list.
 */
function partitionProviders(providers: readonly Provider[]): {
  inUse: Provider[];
  rest: Provider[];
} {
  const listed = providers.filter((provider) => provider.kind !== "service");
  return {
    inUse: listed
      .filter((provider) => providerState(provider) !== ProviderState.NotSet)
      .sort((a, b) => providerState(a) - providerState(b)),
    rest: listed.filter(
      (provider) => providerState(provider) === ProviderState.NotSet,
    ),
  };
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

interface ProviderMenuHandlers {
  onReplaceClient: (provider: OAuthProvider) => void;
  onForgetClient: (provider: OAuthProvider) => void;
  onRemove: (provider: Provider) => void;
}

interface ProviderActionHandlers extends ProviderMenuHandlers {
  /** Opens what the provider lacks: the client dialog, or the key's terminal command. */
  onSetUp: (provider: Provider) => void;
}

/** A provider's menu: its client for an OAuth one, Remove for a registered row; none for a built-in key. */
function ProviderMenu({
  provider,
  onReplaceClient,
  onForgetClient,
  onRemove,
}: { provider: Provider } & ProviderMenuHandlers) {
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

/**
 * A phone's row is one line: a provider's name, its status and Set up. The
 * table keeps the rest: the id, its kind and where it comes from, the apps
 * that list it, and the client or hosts.
 */
function NameCell({ provider }: { provider: Provider }) {
  const inCard = useInDataTableCard();
  return (
    <>
      <p className="truncate font-medium">{provider.name}</p>
      {inCard ? null : (
        <p className="truncate font-mono text-xs text-muted-foreground">
          {provider.id}
        </p>
      )}
    </>
  );
}

/** What a provider is, over where it comes from. */
function KindCell({
  provider,
  isAiDefault,
}: {
  provider: Provider;
  isAiDefault: boolean;
}) {
  return (
    <>
      <p>{isAiDefault ? "AI default" : KIND_LABEL[provider.kind]}</p>
      <p className="text-xs text-muted-foreground">
        {SOURCE_LABEL[provider.source]}
      </p>
    </>
  );
}

/** The apps that list a provider, by name. */
function AppsCell({ provider }: { provider: Provider }) {
  if (provider.apps.length === 0)
    return <span className="text-muted-foreground">none</span>;
  const names = provider.apps.map((app) => app.name).join(", ");
  return (
    <span className="line-clamp-3" title={names}>
      {names}
    </span>
  );
}

/**
 * An OAuth provider's client, by where it comes from and never its value,
 * over how many people have connected. Any other provider lists the hosts
 * its key goes to.
 */
function ClientCell({ provider }: { provider: Provider }) {
  const entry = provider.oauth;
  if (!entry) {
    if (provider.hosts.length === 0) return null;
    const hosts = provider.hosts.join(", ");
    // Capped, so a long list of hosts doesn't take the Apps column's room.
    return (
      <span
        className="line-clamp-2 max-w-60 text-xs text-muted-foreground"
        title={hosts}
      >
        {hosts}
      </span>
    );
  }
  const view = clientSourceLabel(entry.client);
  const stale = entry.client.stale ? (
    <Badge variant="warning" size="sm" className="ml-2">
      Pasted for other endpoints
    </Badge>
  ) : null;
  return (
    <>
      <p className={view.tone === "unset" ? "text-muted-foreground" : ""}>
        {view.label}
        {stale}
      </p>
      <p className="text-xs text-muted-foreground">
        {entry.connections}{" "}
        {entry.connections === 1 ? "connection" : "connections"}
      </p>
    </>
  );
}

function providerColumns({
  aiDefault,
  onSetUp,
  ...menu
}: ProviderActionHandlers & {
  /** The provider the default model runs on, or null: its kind says so. */
  aiDefault: string | null;
}): ColumnDef<Provider>[] {
  return guardCells([
    {
      accessorKey: "name",
      header: ({ column }) => (
        <SortableHeader column={column} label="Provider" />
      ),
      meta: { label: "Provider", cellClassName: "max-w-[260px]" },
      cell: ({ row: { original: provider } }) => (
        <NameCell provider={provider} />
      ),
    },
    {
      accessorKey: "kind",
      header: ({ column }) => <SortableHeader column={column} label="Kind" />,
      meta: {
        label: "Kind",
        cellClassName: "whitespace-nowrap",
        card: CardSlot.Hidden,
      },
      cell: ({ row: { original: provider } }) => (
        <KindCell provider={provider} isAiDefault={provider.id === aiDefault} />
      ),
    },
    {
      id: "apps",
      header: "Apps",
      enableSorting: false,
      meta: {
        cellClassName: "min-w-32 max-w-[280px]",
        card: CardSlot.Hidden,
      },
      cell: ({ row: { original: provider } }) => (
        <AppsCell provider={provider} />
      ),
    },
    {
      id: "status",
      accessorFn: providerState,
      header: ({ column }) => <SortableHeader column={column} label="Status" />,
      meta: {
        label: "Status",
        cellClassName: "whitespace-nowrap",
        card: CardSlot.Trailing,
      },
      cell: ({ row: { original: provider } }) =>
        STATE_BADGE[providerState(provider)],
    },
    {
      id: "client",
      header: "OAuth client",
      enableSorting: false,
      meta: { card: CardSlot.Hidden },
      cell: ({ row: { original: provider } }) => (
        <ClientCell provider={provider} />
      ),
    },
    {
      // Its own column, so the buttons line up whether or not a row has a menu.
      id: SETUP_COLUMN,
      header: () => <span className="sr-only">Set up</span>,
      enableSorting: false,
      meta: {
        headerClassName: "w-px",
        cellClassName: "text-right",
        card: CardSlot.Trailing,
      },
      cell: ({ row: { original: provider } }) =>
        providerState(provider) === ProviderState.NeedsSetup ? (
          // text-foreground: a card's trailing slot mutes its text.
          <Button
            size="sm"
            variant="outline"
            className="text-foreground"
            onClick={() => onSetUp(provider)}
          >
            Set up
          </Button>
        ) : null,
    },
    {
      id: ACTIONS_COLUMN,
      header: () => <span className="sr-only">Actions</span>,
      enableSorting: false,
      meta: { headerClassName: "w-10" },
      cell: ({ row: { original: provider } }) => (
        <ProviderMenu provider={provider} {...menu} />
      ),
    },
  ]);
}

/**
 * A phone's row says whose connection it is, the provider and its status,
 * over the apps allowed to use it. The table keeps the rest: the account's
 * name at the provider, the scopes and when it was last used.
 */
function WhoCell({ connection }: { connection: Connection }) {
  const inCard = useInDataTableCard();
  const who = personOf(connection);
  return (
    <>
      <p className="truncate font-medium">{who}</p>
      {!inCard && connection.label && connection.label !== who ? (
        <p className="truncate text-xs text-muted-foreground">
          {connection.label}
        </p>
      ) : null}
    </>
  );
}

/** The apps a person allowed, each with the button that takes its access away. */
function AllowedAppsCell({
  connection,
  onRemoveApp,
}: {
  connection: Connection;
  onRemoveApp: (access: AppAccess<Connection>) => void;
}) {
  const inCard = useInDataTableCard();
  if (connection.apps.length === 0) {
    return inCard ? null : <span className="text-muted-foreground">none</span>;
  }
  return (
    <ConnectionApps
      apps={connection.apps}
      onRemove={(app) => onRemoveApp({ connection, app })}
    />
  );
}

function connectionColumns({
  onDisconnect,
  onRemoveApp,
}: {
  onDisconnect: (connection: Connection) => void;
  onRemoveApp: (access: AppAccess<Connection>) => void;
}): ColumnDef<Connection>[] {
  return [
    {
      id: "who",
      accessorFn: personOf,
      header: ({ column }) => <SortableHeader column={column} label="Who" />,
      meta: { label: "Who", cellClassName: "max-w-[240px]" },
      cell: ({ row: { original: connection } }) => (
        <WhoCell connection={connection} />
      ),
    },
    {
      accessorKey: "providerName",
      header: ({ column }) => (
        <SortableHeader column={column} label="Provider" />
      ),
      meta: { label: "Provider", card: CardSlot.BareDetail },
    },
    {
      id: "apps",
      header: "Apps",
      enableSorting: false,
      meta: { cellClassName: "max-w-[280px]", card: CardSlot.Footer },
      cell: ({ row: { original: connection } }) => (
        <AllowedAppsCell connection={connection} onRemoveApp={onRemoveApp} />
      ),
    },
    {
      id: "scopes",
      header: "Scopes",
      enableSorting: false,
      meta: {
        cellClassName: "font-mono text-xs text-muted-foreground",
        card: CardSlot.Hidden,
      },
      cell: ({ row: { original: connection } }) =>
        scopesText(connection.scopes),
    },
    {
      accessorKey: "status",
      header: "Status",
      enableSorting: false,
      meta: { card: CardSlot.BareDetail },
      cell: ({ row: { original: connection } }) => (
        <ConnectionStatusBadge connection={connection} />
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
        cellClassName: DATE_CELL,
        card: CardSlot.Hidden,
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
          label={`Actions for ${personOf(connection)}'s ${connection.providerName} connection`}
        >
          <DropdownMenuItem
            variant="destructive"
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
 * Manage workspace → Providers (docs/design/2026-11-oauth-simplify.md):
 * one table of the providers the Gateway brokers, first what is set up and
 * what still needs it, with the rest of the catalog behind Show all, ten
 * rows to a page: the apps that list each one, where its key or client comes from (never a
 * value), and an OAuth one's connection count; Add OAuth provider from a
 * preset or a custom spec with the client pasted in; Set up, Replace or
 * Forget a client; Remove a registered provider; and, under Organization
 * connections, every connection in the organization
 * (docs/design/2026-11-oauth-one-connection.md): one person's to one
 * provider, with the apps they allowed to use it, ten to a page. One app's access can be
 * taken away, and Disconnect stops every app at once. Owners and admins.
 */
function ProvidersPage() {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [replacing, setReplacing] = useState<OAuthProvider | null>(null);
  const [forgetting, setForgetting] = useState<OAuthProvider | null>(null);
  const [removing, setRemoving] = useState<Provider | null>(null);
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
  const removeMutation = useMutation({
    mutationFn: removeProvider,
    onSuccess: async () => {
      await refresh();
      toast.success("Provider removed");
    },
    onError: (error) =>
      toast.error(getRuleErrorMessage(error, "Failed to remove the provider")),
  });
  const removal = useConnectionRemoval<Connection>({
    person: personOf,
    onChanged: refresh,
  });

  const providerCols = useMemo(
    () =>
      providerColumns({
        aiDefault,
        onSetUp: (provider) =>
          provider.oauth
            ? setReplacing(provider.oauth)
            : setSettingKey(provider),
        onReplaceClient: setReplacing,
        onForgetClient: setForgetting,
        onRemove: setRemoving,
      }),
    [aiDefault],
  );
  const groups = useMemo(
    () => partitionProviders(providersQuery.data?.providers ?? []),
    [providersQuery.data],
  );
  const needle = search.trim().toLowerCase();
  const listed = useMemo(() => {
    if (!showAll) return groups.inUse;
    const all = [...groups.inUse, ...groups.rest];
    return needle
      ? all.filter(
          (provider) =>
            provider.name.toLowerCase().includes(needle) ||
            provider.id.includes(needle),
        )
      : all;
  }, [groups, showAll, needle]);
  const providersTable = useDataTable({
    data: listed,
    columns: providerCols,
    getRowId: (provider) => provider.id,
    withSorting: true,
    withPagination: true,
  });
  const connectionCols = useMemo(
    () =>
      connectionColumns({
        onDisconnect: removal.askDisconnect,
        onRemoveApp: removal.askRemoveApp,
      }),
    [removal.askDisconnect, removal.askRemoveApp],
  );
  const connectionsTable = useDataTable({
    data: connectionsQuery.data?.connections ?? [],
    columns: connectionCols,
    getRowId: (connection) => connection.id,
    withSorting: true,
    withPagination: true,
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
    <SettingsTab>
      <SettingsSection
        title="Providers"
        hint="Set up the outside services your apps use, like OpenAI or Google."
        action={
          <Button onClick={() => setAdding(true)}>
            <Plus data-icon="inline-start" />
            Add OAuth provider
          </Button>
        }
      >
        <DataTable
          table={providersTable}
          isLoading={providersQuery.isPending}
          error={
            providersQuery.isError ? (
              <ErrorState
                message="Couldn't load the providers."
                onRetry={() => void providersQuery.refetch()}
                isRetrying={providersQuery.isFetching}
              />
            ) : undefined
          }
          toolbar={
            showAll ? (
              <DataTableToolbar>
                <DataTableSearch
                  label="Search providers"
                  value={search}
                  onChange={setSearch}
                />
              </DataTableToolbar>
            ) : undefined
          }
          isFiltered={needle !== ""}
          filteredTitle="No providers match"
          onClearFilters={() => setSearch("")}
          empty={{
            title: "Nothing is set up yet",
            description:
              "Set a key from the terminal, or add an OAuth provider.",
            action:
              !showAll && groups.rest.length > 0 ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowAll(true)}
                >
                  Show all providers
                </Button>
              ) : undefined,
          }}
          footer={
            // The rest of the catalog, as the table's last row: what is
            // hidden belongs to this list, and the chevron says it opens.
            !showAll && groups.inUse.length > 0 && groups.rest.length > 0 ? (
              <div className="flex items-center justify-between gap-3 border-t border-border bg-muted/50 px-4 py-2">
                <p className="text-sm text-muted-foreground">
                  {groups.rest.length} more{" "}
                  {groups.rest.length === 1 ? "provider" : "providers"}{" "}
                  available
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowAll(true)}
                >
                  Show all
                  <ChevronDown data-icon="inline-end" />
                </Button>
              </div>
            ) : undefined
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Organization connections"
        hint="Personal accounts, like Gmail, that people have connected, and the apps they allow to use them."
      >
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
            description: "People connect an account once, from inside an app.",
          }}
        />
      </SettingsSection>

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

      {removal.dialogs}
    </SettingsTab>
  );
}
