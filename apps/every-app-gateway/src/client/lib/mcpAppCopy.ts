/**
 * Every string of the MCP app screens, in one place like FIRST_SCREEN
 * (firstScreen.ts), so the copy is read and edited as a whole and the
 * tests read one source: the Add app chooser's "Add an MCP server" row,
 * its form and result, the MCP app edit dialog, the row menu, the remove
 * confirmation and the launcher dialog's example for a remote server.
 * A person reads "MCP app"; the code's tier is "provider".
 */
import type {
  RemoteMcpAuthKind,
  RemoteMcpRiskDefault,
  RemoteToolRiskSource,
  ToolRisk,
} from "@every-app/sdk/internal";

const RISK_DEFAULT_ITEMS: readonly {
  value: RemoteMcpRiskDefault;
  label: string;
  help: string;
}[] = [
  {
    value: "annotations",
    label: "Annotations (recommended)",
    help: "The server's hints decide: a tool marked read-only is read, one marked destructive is destructive, and anything else is write.",
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
  /** The Add app chooser's row, between the four apps and Build your own. */
  chooserRow: {
    title: "Add an MCP server",
    line: "Any remote MCP server, served to your AI clients through this Gateway",
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
      { value: "basic", label: "User and password" },
      { value: "oauth", label: "OAuth (not supported yet)" },
    ] as readonly { value: RemoteMcpAuthKind; label: string }[],
    credentialHelp: {
      none: "A public server: nothing to set.",
      bearer: "Sent as Authorization: Bearer <token>.",
      header: "Sent in a header you name, like X-Api-Key.",
      basic: "Set as user:password, sent as Authorization: Basic.",
      oauth:
        "The Gateway can't sign in to a server with OAuth yet. The app is added and serves no tools until it can.",
    } satisfies Record<RemoteMcpAuthKind, string>,
    headerLabel: "Header name",
    headerPlaceholder: "X-Api-Key",
    secretLabel: "Credential setting name",
    secretHelp:
      "The Gateway setting that holds it. The operator sets the value with the command shown next; it never goes through this page.",
    riskLabel: "Risk default",
    riskItems: RISK_DEFAULT_ITEMS,
    submit: "Add server",
    back: "Back",
    errors: {
      url: "Give the server's URL.",
      urlParse: "The URL doesn't parse.",
      noName: "No name could be read from the URL's host; give it one.",
      header: "Name the header, like X-Api-Key.",
      failed: "The server couldn't be added. Try again.",
    },
  },
  added: {
    credentialTitle: (name: string) => `Set ${name}'s credential`,
    credentialIntro:
      "Run this in a terminal, in the folder where you set up Every App:",
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
    oauth:
      "Added. This server wants OAuth, which the Gateway doesn't support yet, so it serves no tools until then.",
  },
  edit: {
    title: (name: string) => `Edit ${name}`,
    description: (id: string) =>
      `An MCP app. Agents call its tools as ${id}_<tool>.`,
    serverLabel: "Server",
    credentialLabel: "Credential",
    credential: {
      none: "None: a public server.",
      unsupported:
        "OAuth: not supported yet. The server serves no tools until it is.",
      not_set: (name: string) =>
        `${name} is not set. Only the Gateway's operator can set it:`,
      set: (name: string) =>
        `${name} is set. The Gateway binds it to this server on first use.`,
      bound: (name: string, origin: string) =>
        `${name} is set, bound to ${origin}.`,
      bound_elsewhere: (name: string, origin: string) =>
        `${name} is bound to another origin (${origin}): run secret set again.`,
    },
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
    noToolsNeedsCredential: "Its tools are listed once its credential is set.",
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
      { value: "destructive", label: "Destructive" },
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
    destructiveNote:
      "Destructive tools are hidden from AI clients: the Gateway has no approval step for them yet.",
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
    againRemote: "To use it again, add it again from Add app.",
    againBuiltinCommand: (id: string) => `pnpm everyapp mcp on ${id}`,
    againBuiltin: "turns it on again, for owners and admins first.",
  },
  /** The launcher's "Use it from your agent" dialog, for a remote server. */
  useDialog: {
    genericExample: (name: string) =>
      `List what ${name} offers, then use one of its tools.`,
  },
  // The status words ("Off", "Not supported yet") are AppStatusLabel's
  // (appStatus.ts), with every other app's.
} as const;
