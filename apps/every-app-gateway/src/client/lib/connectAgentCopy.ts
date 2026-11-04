/**
 * Every string of "Connect your agent", in one place like FIRST_SCREEN
 * (firstScreen.ts): the sidebar item, its dialog and the block above the AI
 * connections list. The commands follow /docs/connect-ai and each client's
 * own docs (Codex: `codex mcp add --url`, `codex mcp login`; Cursor:
 * `mcp.json` with a `url`); check them there before changing one.
 */

/** The person's page on connecting Claude, ChatGPT and Claude Code. */
export const CONNECT_AI_DOCS_URL = "https://everyapp.com/docs/connect-ai";

type ConnectClientId = "claude" | "claude-code" | "codex" | "cursor" | "other";

interface ConnectStep {
  /** What to do. */
  text: string;
  /** The command, file or address to paste, from this Gateway's /mcp address. */
  code?: (address: string) => string;
}

interface ConnectClient {
  id: ConnectClientId;
  /** The tab's label. */
  label: string;
  /** Numbered under the tab, as many as the client needs. */
  steps: readonly ConnectStep[];
}

/** The last step everywhere: the Gateway's sign-in page asks which apps. */
const SIGN_IN = "Sign in and choose which apps it can use";

export const CONNECT_AGENT_COPY = {
  /** The sidebar item and the dialog's title. */
  title: "Connect your agent",
  clients: [
    {
      id: "claude",
      label: "Claude & ChatGPT",
      steps: [
        { text: "Copy this URL", code: (address) => address },
        { text: "In Claude or ChatGPT, add a custom connector and paste it" },
        { text: SIGN_IN },
      ],
    },
    {
      id: "claude-code",
      label: "Claude Code",
      steps: [
        {
          text: "Run this in a terminal",
          code: (address) =>
            `claude mcp add --transport http everyapp ${address}`,
        },
        { text: "Type /mcp, choose everyapp, then Authenticate" },
        { text: SIGN_IN },
      ],
    },
    {
      id: "codex",
      label: "Codex",
      steps: [
        {
          text: "Add EveryApp",
          code: (address) => `codex mcp add everyapp --url ${address}`,
        },
        { text: SIGN_IN, code: () => "codex mcp login everyapp" },
      ],
    },
    {
      id: "cursor",
      label: "Cursor",
      steps: [
        {
          text: "Add this to ~/.cursor/mcp.json",
          code: (address) =>
            JSON.stringify(
              { mcpServers: { everyapp: { url: address } } },
              null,
              2,
            ),
        },
        { text: "Sign in when Cursor asks" },
      ],
    },
    {
      id: "other",
      label: "Other",
      steps: [
        { text: "Add an MCP server with this URL", code: (address) => address },
        { text: SIGN_IN },
      ],
    },
  ] satisfies readonly ConnectClient[],
  /** Under the Other tab, for tools that can't sign in, by the reader's role. */
  token: {
    manager:
      "Tools that can't sign in take a personal access token as an Authorization: Bearer header:",
    managerLink: "Manage workspace → Tokens",
    member:
      "Tools that can't sign in need a personal access token: ask an owner or admin for one.",
  },
  connectionsLink: "See or revoke connections",
  docsLink: "Docs",
} as const;
