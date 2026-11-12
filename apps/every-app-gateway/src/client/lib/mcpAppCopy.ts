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
    label: "Annotations (recommended)",
    help: "The server's hints decide: a tool marked read-only is read, and anything else is write.",
  },
  {
    value: "write",
    label: "Everything write",
    help: "Every tool is write, whatever the server says: only members with read and write access get them.",
  },
  {
    value: "read",
    label: "Everything read",
    help: "Every tool is read, whatever the server says: for a server you know only reads, like a docs or search server.",
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
    description:
      "Its tools reach your AI clients through this Gateway's MCP address, with the Gateway holding its credential.",
    urlLabel: "URL",
    urlPlaceholder: "https://example.com/mcp",
    urlHelp:
      "The server's MCP address. The Gateway sends its requests and its credential here and nowhere else.",
    nameLabel: "Name",
    nameHelp: (id: string) =>
      id
        ? `Its tools reach AI clients as ${id}_<tool>. Lowercase letters, digits and hyphens.`
        : "Lowercase letters, digits and hyphens. Left empty, it comes from the URL.",
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
      none: "A public server: nothing to set.",
      bearer: "Sent as Authorization: Bearer <token>.",
      header: "Sent in a header you name, like X-Api-Key.",
      query: "Sent as a query parameter on the server's URL.",
      basic: "Set as user:password, sent as Authorization: Basic.",
      oauth:
        "Each member signs in to the server with their own account. The Gateway registers itself with the server and holds the tokens.",
      provider:
        "A provider already on this Gateway, whose key or sign-in the server takes.",
    } satisfies Record<AddCredentialChoice, string>,
    /** Where a static credential's value is set: never on this page. */
    tokenSettingHelp: (setting: string) =>
      `The value is the Gateway setting ${setting}. The operator sets it with the command shown next; it never goes through this page.`,
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
    clientIntro:
      "This server can't register the Gateway as a client. Register one in its console with this redirect URI, then paste its client id and secret:",
    clientIdLabel: "Client ID",
    clientSecretLabel: "Client secret (optional)",
    clientSecretHelp:
      "Sealed on the Gateway. Leave it empty for a public client.",
    riskLabel: "Risk default",
    riskItems: RISK_DEFAULT_ITEMS,
    submit: "Add server",
    errors: {
      url: "Give the server's URL.",
      urlParse: "The URL doesn't parse.",
      noName: "No name could be read from the URL's host; give it one.",
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
    operatorNote:
      "Only the Gateway's operator can set it; the app shows Needs setup until then.",
    credentialSet: (secret: string) =>
      `Added. Its credential, ${secret}, is set already; the Gateway lists its tools on first use.`,
    title: (name: string) => `Added ${name}`,
    tools: (count: number, id: string) =>
      count === 1
        ? `Added. 1 tool is on this Gateway's /mcp as ${id}_<tool>.`
        : `Added. ${count} tools are on this Gateway's /mcp as ${id}_<tool>.`,
    firstUse: "Added. The Gateway lists its tools on first use.",
    empty: "Added. The server lists no tools right now.",
    connectTitle: (name: string) => `Connect ${name}`,
    connectIntro:
      "Added. Sign in to the server with your account: the Gateway lists its tools once someone has connected.",
    connect: "Connect your account",
  },
  edit: {
    title: (name: string) => `Edit ${name}`,
    description: (id: string) =>
      `An MCP app. Agents call its tools as ${id}_<tool>.`,
    serverLabel: "Server",
    credentialLabel: "Credential",
    credential: {
      none: "None: a public server.",
      not_set: (name: string) =>
        `${name} is not set. Only the Gateway's operator can set it:`,
      bound_elsewhere: (name: string) =>
        `${name} was set for another server or auth, so nothing is sent to this one. The Gateway's operator sets it again:`,
      ready: (name: string) => `${name} is set for this server.`,
      no_client:
        "The Gateway holds no OAuth client for this server. Add the server again, or add a client under Manage workspace → Providers.",
      not_connected:
        "Nobody has connected an account yet: its tools are listed once someone connects.",
      connected: (count: number) =>
        count === 1 ? "1 account connected." : `${count} accounts connected.`,
      missing:
        "Its provider isn't on this Gateway any more. Remove the app and add it again.",
    },
    providerLine: (name: string, own: boolean) =>
      own ? `${name}, this app's own provider.` : `Provider: ${name}.`,
    connect: "Connect your account",
    reconnect: "Reconnect",
    connectedAs: (label: string | null) =>
      label ? `You're connected as ${label}.` : "You're connected.",
    connectionExpired: "Your connection expired.",
    statusLabel: "Status",
    on: "On: its tools are served.",
    off: "Off: its tools aren't served. Access and tokens are kept.",
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
    noTools: "No tools listed yet. Refresh tools lists them now.",
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
        ? "Annotations"
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
    body: (people: string | null) =>
      `Its tools leave this Gateway's MCP address${people ? `, ${people} lose access to it` : ""}, and its tokens, its tools snapshot and its place in AI connections go. Its credential stays set on the Gateway.`,
    againRemote: "To use it again, add it again under MCP apps.",
    againBuiltinCommand: (id: string) => `pnpm everyapp mcp on ${id}`,
    againBuiltin: "turns it on again, for owners and admins first.",
  },
  /** The "Use it from your agent" dialog: the Connect your agent steps, then this. */
  useDialog: {
    title: (name: string) => `Use ${name} from your agent`,
    ask: "Ask your agent",
    genericExample: (name: string) =>
      `List what ${name} offers, then use one of its tools.`,
    connect: (provider: string) => `Connect your ${provider} account`,
    connectIntro:
      "Its tools act as you on the server: connect your account first.",
    connectedAs: (label: string | null) =>
      label ? `Connected as ${label}.` : "Connected.",
    expired: "The connection expired.",
    reconnect: "Reconnect",
  },
  // The status words ("Off") are AppStatusLabel's
  // (appStatus.ts), with every other app's.
} as const;
