import { Component, useMemo, useState, type ReactNode } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { flexRender, type ColumnDef } from "@tanstack/react-table";
import { KeyRound, Plus, Trash2, Unplug } from "lucide-react";
import { toast } from "sonner";
import { AddOAuthProviderDialog } from "@/client/components/admin/AddOAuthProviderDialog";
import { ProviderHosts } from "@/client/components/admin/ProviderHosts";
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
import { ProviderMark } from "@/client/components/ProviderIcon";
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
  DATE_CELL,
  DateCell,
  dateSortValue,
} from "@/client/components/table/DateCell";
import { SortableHeader } from "@/client/components/table/SortableHeader";
import { useTableSearch } from "@/client/components/table/useTableSearch";
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
import { scopesText } from "@/client/lib/oauthProviders";
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

/** The CLI as the Gateway's commands name it. */
const CLI = "pnpm everyapp";

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
 * `configured`, `settings`, `apps` and `setFromTerminal`, as a cache
 * restored from the browser can be) reads as not set up and listed by no
 * app, instead of throwing and blanking the tab.
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
    setFromTerminal: row.setFromTerminal === true,
    inUse: row.inUse === true,
  };
}

/** Gateway services (email, members) are internals and never list. */
function readProviders(data: { providers: Provider[] }): {
  providers: Provider[];
} {
  return {
    providers: Array.isArray(data.providers)
      ? data.providers
          .map(readProvider)
          .filter((provider) => provider.kind !== "service")
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
  /**
   * Not set, and waited on: an installed app stays closed without it, it
   * was registered here (an OAuth preset a deploy registered, until its
   * client is set), or its pasted client no longer opens. These rows carry
   * Set up, and list first: they are what keeps apps closed.
   */
  NeedsSetup,
  Ready,
  NotSet,
}

function providerState(provider: Provider): ProviderState {
  if (provider.configured) return ProviderState.Ready;
  return provider.source === "row" ||
    provider.oauth?.client.stale === true ||
    provider.apps.some((app) => app.needs)
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
 * What needs setting up first, then what is set up, then the rest of the
 * catalog; in each, the providers more apps list first, then by name.
 */
function orderProviders(providers: readonly Provider[]): Provider[] {
  return [...providers].sort(
    (a, b) =>
      providerState(a) - providerState(b) ||
      b.apps.length - a.apps.length ||
      a.name.localeCompare(b.name),
  );
}

function providerSearchText(provider: Provider) {
  return [
    provider.name,
    provider.id,
    KIND_LABEL[provider.kind],
    ...provider.apps.map((app) => app.name),
  ];
}

function connectionSearchText(connection: Connection) {
  return [
    personOf(connection),
    connection.label,
    connection.providerName,
    ...connection.apps.map((app) => app.name),
  ];
}

/** A change made from the terminal, by name; no value passes through the browser. */
interface TerminalStep {
  title: string;
  description?: string;
  code: string;
  /** The provider the key is set for: where to get it, and the hosts it goes to. */
  docsFor?: Provider;
}

function TerminalDialog({
  step,
  onClose,
}: {
  step: TerminalStep;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{step.title}</DialogTitle>
          {step.description ? (
            <DialogDescription>{step.description}</DialogDescription>
          ) : null}
        </DialogHeader>
        {step.docsFor ? (
          <ol className="flex list-decimal flex-col gap-3 pl-5 text-sm font-medium">
            <li>
              Get a {step.docsFor.name} key (
              <a
                className="underline underline-offset-4 hover:text-primary"
                href={providerDocsUrl(step.docsFor.id)}
                target="_blank"
                rel="noreferrer"
              >
                where to find it
              </a>
              )
            </li>
            <li>
              Run this in a terminal
              <div className="mt-2 -ml-5 font-normal">
                <CodeBlock code={step.code} successMessage="Command copied" />
              </div>
            </li>
          </ol>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">Run this in a terminal</p>
            <CodeBlock code={step.code} successMessage="Command copied" />
          </div>
        )}
        {step.docsFor ? (
          <ProviderHosts hosts={step.docsFor.hosts} what="this key" />
        ) : null}
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}

function setKeyStep(provider: Provider): TerminalStep {
  return {
    title: `${provider.configured ? "Replace" : "Set"} the ${provider.name} key`,
    code: `${CLI} secret set ${provider.settings.join(" ")}`,
    docsFor: provider,
  };
}

function removeKeyStep(provider: Provider): TerminalStep {
  const apps = provider.apps.map((app) => app.name);
  return {
    title: `Remove the ${provider.name} key`,
    description:
      apps.length > 0
        ? `${apps.join(", ")} can't call ${provider.name} until a key is set again.`
        : undefined,
    code: `${CLI} secret unset ${provider.settings.join(" ")}`,
  };
}

function removeTerminalClientStep(entry: OAuthProvider): TerminalStep {
  return {
    title: `Remove the ${entry.name} client`,
    description: "New connections stop until a client is set again.",
    code: `${CLI} secret unset ${entry.settings.join(" ")}`,
  };
}

function removeTerminalProviderStep(provider: Provider): TerminalStep {
  return {
    title: `Remove ${provider.name}`,
    code: `${CLI} provider remove ${provider.id}\n${CLI} secret unset ${provider.settings.join(" ")}`,
  };
}

interface ProviderActionHandlers {
  /** Opens what the provider lacks: the client dialog, or the key's terminal command. */
  onSetUp: (provider: Provider) => void;
  onReplaceClient: (provider: OAuthProvider) => void;
  onForgetClient: (provider: OAuthProvider) => void;
  onTerminal: (step: TerminalStep) => void;
  onRemove: (provider: Provider) => void;
}

/**
 * Every provider's menu: its client or its key, set, replaced or removed,
 * and Remove provider on a registered one, disabled while any app on the
 * Gateway lists it (the Gateway refuses it then). What the terminal set,
 * the terminal removes:
 * those items show the command.
 */
function ProviderMenu({
  provider,
  onSetUp,
  onReplaceClient,
  onForgetClient,
  onTerminal,
  onRemove,
}: { provider: Provider } & ProviderActionHandlers) {
  const entry = provider.oauth;
  const removable = provider.source === "row";
  return (
    <RowActionsMenu label={`Actions for ${provider.name}`}>
      {entry ? (
        <>
          <DropdownMenuItem onClick={() => onReplaceClient(entry)}>
            <KeyRound />
            {entry.client.source ? "Replace client" : "Set client"}
          </DropdownMenuItem>
          {entry.client.source === "d1" ? (
            <DropdownMenuItem onClick={() => onForgetClient(entry)}>
              <Unplug />
              Remove client
            </DropdownMenuItem>
          ) : null}
          {entry.client.source === "env" ? (
            <DropdownMenuItem
              onClick={() => onTerminal(removeTerminalClientStep(entry))}
            >
              <Unplug />
              Remove client
            </DropdownMenuItem>
          ) : null}
        </>
      ) : (
        <>
          <DropdownMenuItem onClick={() => onSetUp(provider)}>
            <KeyRound />
            {provider.configured ? "Replace key" : "Set key"}
          </DropdownMenuItem>
          {provider.configured ? (
            <DropdownMenuItem
              onClick={() => onTerminal(removeKeyStep(provider))}
            >
              <Unplug />
              Remove key
            </DropdownMenuItem>
          ) : null}
        </>
      )}
      {removable ? (
        <DropdownMenuItem
          variant="destructive"
          disabled={provider.inUse}
          onClick={() =>
            provider.setFromTerminal
              ? onTerminal(removeTerminalProviderStep(provider))
              : onRemove(provider)
          }
        >
          <Trash2 />
          Remove provider
        </DropdownMenuItem>
      ) : null}
    </RowActionsMenu>
  );
}

/** A row's name over its id and kind (a person's email over their account's name): one line on a phone. */
function TitleCell({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: ReactNode;
}) {
  const inCard = useInDataTableCard();
  return (
    <>
      <p className="truncate font-medium">{title}</p>
      {!inCard && subtitle ? (
        <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
      ) : null}
    </>
  );
}

/** The line under a provider's name: its id, what the CLI and an app's config call it, then its kind (the default model's provider says so). */
function ProviderSubtitle({
  provider,
  isAiDefault,
}: {
  provider: Provider;
  isAiDefault: boolean;
}) {
  return (
    <>
      <span className="font-mono">{provider.id}</span>
      {" · "}
      {isAiDefault ? "AI default" : KIND_LABEL[provider.kind]}
    </>
  );
}

/** Both tables' Apps column: chips, each with its remove button when `onRemove` is given. */
function AppsCell<TApp extends { rowId: string; name: string }>({
  apps,
  onRemove,
}: {
  apps: readonly TApp[];
  onRemove?: (app: TApp) => void;
}) {
  const inCard = useInDataTableCard();
  if (apps.length === 0) {
    return inCard ? null : <span className="text-muted-foreground">none</span>;
  }
  return <ConnectionApps apps={apps} onRemove={onRemove} />;
}

/** The first scope and how many more, until opened. */
function ScopesCell({ scopes }: { scopes: readonly string[] }) {
  const [open, setOpen] = useState(false);
  if (scopes.length <= 1) return <>{scopesText(scopes)}</>;
  const toggle = (
    <Button
      variant="link"
      size="xs"
      className="h-auto px-0 font-sans text-xs text-muted-foreground hover:text-foreground"
      aria-expanded={open}
      onClick={() => setOpen(!open)}
    >
      {open ? "Show less" : `+${scopes.length - 1} more`}
    </Button>
  );
  return open ? (
    <div className="flex flex-col items-start gap-0.5 whitespace-normal">
      <span className="wrap-anywhere">{scopesText(scopes)}</span>
      {toggle}
    </div>
  ) : (
    <div className="flex items-center gap-1.5">
      <span className="truncate">{scopes[0]}</span>
      {toggle}
    </div>
  );
}

function providerColumns({
  aiDefault,
  ...handlers
}: ProviderActionHandlers & {
  /** The provider the default model runs on, or null: the line under its name says so. */
  aiDefault: string | null;
}): ColumnDef<Provider>[] {
  return guardCells([
    {
      accessorKey: "name",
      header: ({ column }) => (
        <SortableHeader column={column} label="Provider" />
      ),
      meta: { label: "Provider", cellClassName: "max-w-[240px]" },
      cell: ({ row: { original: provider } }) => (
        <div className="flex min-w-0 items-center gap-3">
          {/* A fixed slot, so names line up whether or not a provider has a mark. */}
          <span className="flex size-5 shrink-0 items-center justify-center">
            <ProviderMark id={provider.id} className="size-4.5" />
          </span>
          <div className="min-w-0">
            <TitleCell
              title={provider.name}
              subtitle={
                <ProviderSubtitle
                  provider={provider}
                  isAiDefault={provider.id === aiDefault}
                />
              }
            />
          </div>
        </div>
      ),
    },
    {
      id: "apps",
      header: "Apps",
      enableSorting: false,
      meta: { cellClassName: "max-w-[280px]", card: CardSlot.Footer },
      cell: ({ row: { original: provider } }) => (
        <AppsCell apps={provider.apps} />
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
      // Its own column, so the buttons line up whether or not a row needs one.
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
            onClick={() => handlers.onSetUp(provider)}
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
        <ProviderMenu provider={provider} {...handlers} />
      ),
    },
  ]);
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
        <TitleCell
          title={personOf(connection)}
          subtitle={
            connection.label !== personOf(connection) ? connection.label : null
          }
        />
      ),
    },
    {
      accessorKey: "providerName",
      header: ({ column }) => (
        <SortableHeader column={column} label="Provider" />
      ),
      meta: {
        label: "Provider",
        cellClassName: "whitespace-nowrap",
        card: CardSlot.BareDetail,
      },
    },
    {
      id: "apps",
      header: "Apps",
      enableSorting: false,
      meta: { cellClassName: "max-w-[280px]", card: CardSlot.Footer },
      cell: ({ row: { original: connection } }) => (
        <AppsCell
          apps={connection.apps}
          onRemove={(app) => onRemoveApp({ connection, app })}
        />
      ),
    },
    {
      id: "scopes",
      header: "Scopes",
      enableSorting: false,
      meta: {
        cellClassName: "max-w-[240px] font-mono text-xs text-muted-foreground",
        card: CardSlot.Hidden,
      },
      cell: ({ row: { original: connection } }) => (
        <ScopesCell scopes={connection.scopes} />
      ),
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
      id: ACTIONS_COLUMN,
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

/** What removing a registered provider takes with it. */
function removalText(provider: Provider): string {
  if (!provider.oauth) return "No app uses it.";
  const { connections } = provider.oauth;
  if (connections === 0) return "Its OAuth client is deleted.";
  return `Its OAuth client is deleted, and ${connections} connected ${connections === 1 ? "account is" : "accounts are"} disconnected.`;
}

/**
 * Manage workspace → Providers (docs/design/2026-11-oauth-simplify.md):
 * every provider the Gateway brokers, what needs setting up first, then
 * what is set up, then the rest of the catalog, searchable and ten rows to
 * a page: the apps that list each one and its status; Add OAuth provider
 * from a preset or a custom spec with the client pasted in; Set up,
 * Replace or Forget a client, set or remove a key (from the terminal: the
 * menu shows the command); Remove a registered provider no app on the
 * Gateway lists; and,
 * under Organization connections, every connection in the organization
 * (docs/design/2026-11-oauth-one-connection.md): one person's to one
 * provider, with the apps they allowed to use it, searchable and ten to a
 * page. One app's access can be taken away, and Disconnect stops every
 * app at once. Owners and admins.
 */
function ProvidersPage() {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [replacing, setReplacing] = useState<OAuthProvider | null>(null);
  const [forgetting, setForgetting] = useState<OAuthProvider | null>(null);
  const [removing, setRemoving] = useState<Provider | null>(null);
  const [terminal, setTerminal] = useState<TerminalStep | null>(null);

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
      toast.success("Client removed");
    },
    onError: (error) =>
      toast.error(getRuleErrorMessage(error, "Failed to remove the client")),
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
            : setTerminal(setKeyStep(provider)),
        onReplaceClient: setReplacing,
        onForgetClient: setForgetting,
        onTerminal: setTerminal,
        onRemove: setRemoving,
      }),
    [aiDefault],
  );
  const orderedProviders = useMemo(
    () => orderProviders(providersQuery.data?.providers ?? []),
    [providersQuery.data],
  );
  const providerSearch = useTableSearch(
    orderedProviders,
    providerSearchText,
    "providers",
  );
  const providersTable = useDataTable({
    data: providerSearch.rows,
    columns: providerCols,
    getRowId: (provider) => provider.id,
    withSorting: true,
  });

  const connectionCols = useMemo(
    () =>
      connectionColumns({
        onDisconnect: removal.askDisconnect,
        onRemoveApp: removal.askRemoveApp,
      }),
    [removal.askDisconnect, removal.askRemoveApp],
  );
  const connectionSearch = useTableSearch(
    connectionsQuery.data?.connections ?? [],
    connectionSearchText,
    "connections",
  );
  const connectionsTable = useDataTable({
    data: connectionSearch.rows,
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
          search={providerSearch.search}
          empty={{ title: "No providers" }}
        />
      </SettingsSection>

      <SettingsSection
        title="Organization connections"
        hint="Accounts people have connected, like Gmail."
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
          search={connectionSearch.search}
          empty={{
            title: "No connections yet",
            description: "People connect accounts from inside an app.",
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

      {terminal ? (
        <TerminalDialog step={terminal} onClose={() => setTerminal(null)} />
      ) : null}

      {replacing ? (
        <ReplaceOAuthClientDialog
          provider={{
            id: replacing.id,
            name: replacing.name,
            redirectUri: replacing.redirectUri,
            console: replacing.console,
            hosts: replacing.hosts,
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
          title={`Remove the ${forgetting.name} client?`}
          confirmLabel="Remove client"
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
          New connections stop until a client is set again. Existing ones work
          until they expire.
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
          {removalText(removing)}
        </ConfirmDialog>
      ) : null}

      {removal.dialogs}
    </SettingsTab>
  );
}
