/**
 * Every string of the MCP app screens, in one place like FIRST_SCREEN
 * (firstScreen.ts), so the copy is read and edited as a whole and the
 * tests read one source: the MCP apps section of Admin → Apps, the
 * "Add an MCP server" form and result, the MCP app edit dialog, the row menu, the remove
 * confirmation and the launcher dialog's example for a remote server.
 * A person reads "MCP app"; the code's tier is "provider".
 */
import type {
  RemoteMcpCredentialKind,
  RemoteMcpRiskDefault,
  RemoteToolRiskSource,
  ToolRisk,
} from "@every-app/sdk/internal";

/** The Add form's credential choices: a kind the add turns into a provider row, or an existing provider. */
export type AddCredentialChoice = RemoteMcpCredentialKind | "provider";

const RISK_DEFAULT_ITEMS: readonly {
  value: RemoteMcpRiskDefault;
  label: string;
  help: string;
}[] = [
  {
    value: "annotations",
    label: "Follow the server (recommended)",
    help: "Tools the server marks read-only are read. The rest are write.",
  },
  {
    value: "write",
    label: "Treat every tool as write",
    help: "Only members with read and write access get its tools.",
  },
  {
    value: "read",
    label: "Treat every tool as read",
    help: "For servers that only read, like docs or search.",
  },
];

export const MCP_APP_COPY = {
  /** Admin → Apps' section under the apps table. */
  section: {
    title: "MCP apps",
    hint: "Agents connected to this Gateway can use the tools in these apps.",
    add: "Add MCP server",
    nameColumn: "App",
    whoColumn: "Who can use",
    noun: "MCP apps",
    empty: "No MCP apps yet",
    addedBy: (actor: string) => `Added by ${actor}`,
    connectedBy: (actor: string) => `Connected by ${actor}`,
  },
  addForm: {
    title: "Add an MCP server",
    description: "Your agents can use its tools.",
    urlLabel: "URL",
    urlPlaceholder: "https://example.com/mcp",
    nameLabel: "Name (optional)",
    nameHelp: "Lowercase letters, digits and hyphens.",
    credentialLabel: "Credential",
    credentialItems: [
      { value: "none", label: "None" },
      { value: "bearer", label: "Bearer token" },
      { value: "header", label: "Header" },
      { value: "query", label: "Query parameter" },
      { value: "basic", label: "User and password" },
      { value: "oauth", label: "OAuth (sign in)" },
      { value: "provider", label: "Use a provider" },
    ] as readonly { value: AddCredentialChoice; label: string }[],
    credentialHelp: {
      basic: "Set as user:password.",
      oauth: "Each member signs in with their own account.",
    } satisfies Partial<Record<AddCredentialChoice, string>> as Partial<
      Record<AddCredentialChoice, string>
    >,
    /** Where a static credential's value is set: never on this page. */
    tokenSettingHelp: "You'll set its value with a command in the next step.",
    headerLabel: "Header name",
    headerPlaceholder: "X-Api-Key",
    prefixLabel: "Prefix (optional)",
    prefixHelp: "Text sent before the value, like Token followed by a space.",
    paramLabel: "Parameter name",
    paramPlaceholder: "api_key",
    providerLabel: "Provider",
    providersLoading: "Loading providers…",
    providersNone:
      "No API-key or OAuth provider is on this Gateway yet. Add one under Manage workspace → Providers.",
    /** Numbered, for a server that can't register the Gateway as a client itself. */
    clientRegisterStep:
      "In the server's console, create an OAuth client with this redirect URI",
    clientPasteStep: "Paste its client ID and secret",
    clientIdLabel: "Client ID",
    clientSecretLabel: "Client secret (optional)",
    riskLabel: "Risk default",
    riskItems: RISK_DEFAULT_ITEMS,
    submit: "Add server",
    errors: {
      url: "Enter the URL.",
      urlParse: "Enter the full URL, https:// included.",
      noName: "Enter a name.",
      header: "Name the header, like X-Api-Key.",
      param: "Name the query parameter, like api_key.",
      provider: "Choose a provider.",
      clientId: "Paste the client id.",
      failed: "The server couldn't be added. Try again.",
    },
  },
  added: {
    credentialTitle: (name: string) => `Set ${name}'s credential`,
    credentialIntro:
      "Run this in a terminal, in the folder where you set up EveryApp:",
    credentialSet: "Its credential is already set.",
    title: (name: string) => `Added ${name}`,
    tools: (count: number) =>
      count === 1 ? "1 tool added." : `${count} tools added.`,
    empty: "The server has no tools right now.",
    connectTitle: (name: string) => `Connect ${name}`,
    connectIntro: "Connect your account to load its tools.",
    connect: "Connect your account",
  },
  edit: {
    title: (name: string) => `Edit ${name}`,
    serverLabel: "Server",
    credentialLabel: "Credential",
    credential: {
      none: "None",
      not_set: (name: string) => `${name} isn't set. Run:`,
      bound_elsewhere: (name: string) =>
        `${name} was set for a different server. Set it again:`,
      ready: (name: string) => `${name} is set for this server.`,
      no_client:
        "The Gateway holds no OAuth client for this server. Add the server again, or add a client under Manage workspace → Providers.",
      not_connected: "No accounts connected yet.",
      connected: (count: number) =>
        count === 1 ? "1 account connected." : `${count} accounts connected.`,
      missing:
        "Its provider isn't on this Gateway any more. Remove the app and add it again.",
    },
    providerLine: (name: string) => `Provider: ${name}`,
    connect: "Connect your account",
    reconnect: "Reconnect",
    connectedAs: (label: string | null) =>
      label ? `You're connected as ${label}.` : "You're connected.",
    connectionExpired: "Your connection expired.",
    statusLabel: "Status",
    on: "On",
    off: "Off",
    turnOn: "Turn on",
    turnOff: "Turn off",
    toolsLabel: "Tools",
    lastListed: (when: string) => `Last listed ${when}.`,
    neverListed: "Not listed yet.",
    listingFailed: (message: string) => `The last listing failed: ${message}`,
    refresh: "Refresh tools",
    refreshAdded: (names: string[]) => `Added: ${names.join(", ")}.`,
    refreshRemoved: (names: string[]) => `Removed: ${names.join(", ")}.`,
    refreshNoChange: "No change.",
    noTools: "No tools yet.",
    noToolsNeedsCredential:
      "Its tools are listed once its credential is set or an account is connected.",
    riskLabel: "Risk default",
    riskItems: RISK_DEFAULT_ITEMS,
    columns: {
      name: "Name",
      serverName: "Server name",
      risk: "Risk",
      on: "On",
    },
    /** The per-tool risk select; the first clears the override. */
    toolRiskNone: (appDefault: RemoteMcpRiskDefault) =>
      appDefault === "annotations"
        ? "Follow the server"
        : `App default (${appDefault})`,
    toolRiskItems: [
      { value: "read", label: "Read" },
      { value: "write", label: "Write" },
    ] as readonly { value: ToolRisk; label: string }[],
    toolRiskLabel: (name: string) => `Risk of ${name}`,
    toolSwitchLabel: (name: string) => `Serve ${name}`,
    effective: (risk: ToolRisk, source: RemoteToolRiskSource) =>
      `${risk}, ${
        {
          override: "your choice",
          app: "the app's default",
          hint: "the server's hint",
          default: "no hint",
        }[source]
      }`,
    notListed: "Not listed",
    nameLabel: "Name",
    descriptionLabel: "Description",
    save: "Save changes",
    cancel: "Cancel",
    loadFailed: "Couldn't load this MCP app.",
    saveFailed: "Couldn't save the changes.",
  },
  menu: {
    useFromAgent: "Use from your agent",
    manageAccess: "Manage access",
    edit: "Edit",
    turnOff: "Turn off",
    turnOn: "Turn on",
    remove: "Remove",
    turnedOn: (name: string) => `${name} is on.`,
    turnedOff: (name: string) => `${name} is off.`,
    removed: (name: string) => `${name} was removed.`,
    statusFailed: "Couldn't turn the app on or off.",
    removeFailed: "Couldn't remove the app.",
  },
  remove: {
    title: (name: string) => `Remove ${name}?`,
    confirm: "Remove",
    body: (users: number) =>
      `Agents can no longer use its tools${users > 0 ? `, and ${users} ${users === 1 ? "user loses" : "users lose"} access` : ""}.`,
    againBuiltinCommand: (id: string) => `pnpm everyapp mcp on ${id}`,
    againBuiltin: "turns it on again.",
  },
  /** The "Use it from your agent" dialog: the Connect your agent steps, then this. */
  useDialog: {
    title: (name: string) => `Use ${name} from your agent`,
    ask: "Ask your agent",
    genericExample: (name: string) =>
      `List what ${name} offers, then use one of its tools.`,
    connect: (provider: string) => `Connect your ${provider} account`,
    connectedAs: (label: string | null) =>
      label ? `Connected as ${label}.` : "Connected.",
    expired: "The connection expired.",
    reconnect: "Reconnect",
  },
  // The status words ("Off") are AppStatusLabel's
  // (appStatus.ts), with every other app's.
} as const;
