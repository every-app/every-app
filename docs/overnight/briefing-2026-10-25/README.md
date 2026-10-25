# Morning briefing, 2026-10-25

A one-off walkthrough for Ben of what changed overnight before the Monday 2026-10-27 launch: what a new user, an admin and a developer experience now, what is live versus merged, and every open decision as a numbered "Question for Ben" card. Ben scrolls it while screen-recording, answers out loud, and the last screen copies his clicks and notes as plain text to paste back.

Open it from the main checkout after `git pull`:

```sh
open docs/overnight/briefing-2026-10-25/index.html
```

GitHub does not render it. It is one static HTML file plus `images/`: vanilla HTML, CSS and JavaScript, light and dark follow the system, no build step, no network calls, no analytics. Answers persist in the browser's localStorage under the key prefix `ea-briefing-2026-10-25:`.

Question numbers follow the interview items in [docs/overnight/2026-10-24.md](../2026-10-24.md) (branch `t3/overnight-notes`, PR #435). The gateway screenshots are reused from the design review in [docs/design/2026-10-25-ui-review](../../design/2026-10-25-ui-review/README.md); the starter before and after shots come from branch `ui-screenshots-2026-10-24`.

## Added after the page was built: the default model provider (2026-10-25, evening)

Agentic Inbox had no default until now: its Worker picked Workers AI or OpenRouter when it was built, and its manifest and OpenCRM's each required OpenRouter's key, so one person set the same key twice. Now an app says `ai: { chat: true }` and the Gateway answers with whatever its operator configured: the stored choice (`pnpm everyapp ai default <provider>[/<model>]`, or Manage workspace → Usage → AI default), else the first provider of the shipped order whose key is set: OpenRouter, Workers AI, OpenAI, Anthropic, Groq, Mistral, Gemini. On "why not Cloudflare AI Gateway as the default everywhere": it is a proxy with no models of its own and needs an upstream key on every call, so it can't answer the question "which key"; OpenRouter is one key for many models and reports each call's price. The right default when both are set is OpenRouter through AI Gateway (`pnpm everyapp ai gateway on` puts it in front of every model call, keys unchanged), else OpenRouter, else Workers AI. The decisions to confirm are TODO.md "Model providers (2026-10-25)"; the two app pull requests wait for `0.3.0-rc.2` of the SDK and CLI on npm.
