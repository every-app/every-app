/**
 * Every string of the first screen: the gallery an owner or admin meets
 * while the workspace has no apps (four app cards and Build your own), the
 * two dialogs behind the cards, the Add app chooser on Manage workspace →
 * Apps, and the empty states around them. One place, so the copy is read
 * and edited as a whole. The card lines themselves are in featuredApps.ts,
 * beside the repositories, because the README prints the same lines.
 */
export const FIRST_SCREEN = {
  gallery: {
    heading: "Add your first app",
    intro: "Choose one to see its install command, or build your own.",
  },
  buildCard: {
    title: "Build your own",
    line: "Copy a prompt. Your coding agent asks what you need, then builds it.",
  },
  appDialog: {
    description: (name: string) =>
      `${name} is open source and runs behind your Gateway, in your Cloudflare account.`,
    commandHeading: "Run this in a terminal",
    commandNote:
      "Run it in the folder where you set up EveryApp. When it finishes, refresh this page. Run it again later to update.",
    needsHeading: "Before it opens",
    needsNote:
      "After the install, the app shows Needs setup here, with the command that sets them.",
    memberLine: "Ask an owner or admin to install it.",
    repoLinkLabel: "View on GitHub",
  },
  buildDialog: {
    title: "Build your own app",
    description:
      "Paste this into Claude Code, Codex or Cursor, opened in your every-app folder.",
    copyButton: "Copy prompt",
    docsLinkLabel: "Create an app, in the docs",
  },
  addApp: {
    button: "Add app",
    dialogTitle: "Add an app",
    dialogDescription:
      "Choose one to see its install command, add any MCP server, or build your own.",
  },
  phoneNotice: "This part takes a computer. Open this page there.",
  empty: {
    memberTitle: "No apps yet",
    memberDescription:
      "They appear here once an owner or admin installs one and gives you access.",
    adminTableTitle: "No apps yet",
    adminTableDescription: "Install an open source app, or build your own.",
  },
} as const;
