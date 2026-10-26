/**
 * Every string of "Connect your agent", in one place like FIRST_SCREEN
 * (firstScreen.ts): the sidebar item, its dialog and the block above the AI
 * connections list. The commands follow /docs/connect-ai and each client's
 * own docs (Codex: `codex mcp add --url`, `codex mcp login`; Cursor:
 * `mcp.json` with a `url`); check them there before changing one.
 */

type ConnectClientId = "claude" | "claude-code" | "codex" | "cursor" | "other";

interface ConnectClient {
  id: ConnectClientId;
  /** The tab's label. */
  label: string;
  /** What to do, before the code block. */
  before: string;
  /** The command or file to paste, from this Gateway's /mcp address. */
  code?: (address: string) => string;
  /** What to do after pasting it. */
  after?: string;
}

export const CONNECT_AGENT_COPY = {
  /** The sidebar item and the dialog's title. */
  title: "Connect your agent",
  intro:
    "One address for every app you can open. Copy it into Claude, ChatGPT, Claude Code, Codex or Cursor:",
  addressCopied: "Address copied",
  clients: [
    {
      id: "claude",
      label: "Claude & ChatGPT",
      before:
        "In Claude (web or desktop) or ChatGPT, add a custom connector and paste the address above.",
    },
    {
      id: "claude-code",
      label: "Claude Code",
      before: "In a terminal, run:",
      code: (address) => `claude mcp add --transport http everyapp ${address}`,
      after: "Then type /mcp in Claude Code, choose everyapp and Authenticate.",
    },
    {
      id: "codex",
      label: "Codex",
      before: "In a terminal, run:",
      code: (address) =>
        `codex mcp add everyapp --url ${address}\ncodex mcp login everyapp`,
    },
    {
      id: "cursor",
      label: "Cursor",
      before:
        "Add this to ~/.cursor/mcp.json (or .cursor/mcp.json in a project):",
      code: (address) =>
        JSON.stringify({ mcpServers: { everyapp: { url: address } } }, null, 2),
      after: "Cursor then asks you to sign in.",
    },
    {
      id: "other",
      label: "Other",
      before: "Add an MCP server with the address above.",
    },
  ] satisfies readonly ConnectClient[],
  /** Under the tabs: what the sign-in page asks. */
  next: "A sign-in page opens: choose the apps, read & write or read only, and allow it. An agent can't delete anything.",
  /** For tools that can't sign in, by the reader's role. */
  token: {
    manager:
      "Tools that can't sign in take a personal access token as an Authorization: Bearer header:",
    managerLink: "Manage workspace → Tokens",
    member:
      "Tools that can't sign in need a personal access token: ask an owner or admin for one.",
  },
  connectionsLink: "See or revoke connections",
  docsLink: "Connect an agent, in the docs",
} as const;
