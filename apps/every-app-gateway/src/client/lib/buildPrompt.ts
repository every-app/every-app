/**
 * The "Build your own" dialog: the prompt a person pastes into Claude Code,
 * Codex or Cursor, and the pages it points the agent at. The agent, not the
 * person, runs `everyapp create`; the person answers its questions.
 */

export const BUILD_DOCS = {
  /** The user docs: create, tell your agent what you want, try it, put it online. */
  createAnApp: "https://everyapp.com/docs/create-an-app",
  /** The index of every agent page. */
  llms: "https://everyapp.com/llms.txt",
  /** The build-every-app skill, served as an agent page. */
  build: "https://everyapp.com/docs/agent/build.md",
  /** Pattern → where it lives in starter/ or one of the four app repositories. */
  patterns: "https://everyapp.com/docs/agent/patterns.md",
} as const;

export const BUILD_PROMPT = `Help me build an app on Every App.

Read ${BUILD_DOCS.llms} first, then ${BUILD_DOCS.build} (the build-every-app skill) and ${BUILD_DOCS.patterns}; come back to them whenever unsure. The patterns point at the four example apps and the starter.

Before any code, interview me one short question at a time: what the app is for, who uses it, what it stores, what runs on its own (a schedule, incoming email, an agent), and what stays private. Then describe the app back in a few sentences and wait for my yes.

Then run \`pnpm everyapp create <name>\` from a folder of mine outside the every-app checkout, so the app is its own repository linked to the checkout; build it there, run \`pnpm dev\`, tell me the address, and change it as I try it.

Never build a login page or accounts; the Gateway signs people in. Read who the person is through the SDK and scope every query by user.id. Deploy with \`pnpm everyapp deploy\` only when I say so. Always \`pnpm everyapp\`, never npx.`;
