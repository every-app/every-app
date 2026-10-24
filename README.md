# Every App

> Build the tools your business runs on. Keep them yours.

Every App puts the web apps you build online, in your own Cloudflare account. Cloudflare is the hosting company that runs them; you pay Cloudflare, not us. Each app gets a web address, a database and a sign-in. Open source, alpha, moving fast.

It's so fun making a tool for yourself. But it's still scary to move it off localhost: a login page, users, hosting, keys, keeping it private. Every App does that part once, for every app.

- One Gateway at `apps.yourcompany.com` is your home base: you and the people you invite sign in there and open your apps. Nobody can sign up unless you invite them. No login page in any app.
- It gives each app only what you allow.
- Your coding agent does most of the building.
- A few apps for a small team fit inside Cloudflare's $5 a month Workers Paid plan.

## What you need

- Node.js 22.18 or newer, pnpm and git. Your coding agent can install them for you; by hand, see [Install the tools](https://everyapp.com/docs/gateway#install-the-tools).
- A Cloudflare account on Workers Paid: $5 a month, then usage. The $5 includes 10 million requests and 25 billion database reads a month, and an app adds no fixed cost; past that, Cloudflare bills by use ([its pricing page](https://developers.cloudflare.com/workers/platform/pricing/) has the rates).
- A domain on Cloudflare: buy one there (a `.com` is about $10 a year, a `.dev` or `.app` $1 the first year) or bring one you already own. [Get a domain](https://everyapp.com/docs/domain)

Every App is free and open source. The docs are at https://everyapp.com/docs.

## Your first app

```bash
git clone https://github.com/every-app/every-app.git
cd every-app
pnpm install
pnpm everyapp setup --domain apps.yourcompany.com   # installs your Gateway, about 15 minutes; run again to resume or repair
pnpm everyapp create my-app                          # copies starter/, a simple todo app, to apps/my-app
cd apps/my-app
pnpm dev                                             # http://my-app.localhost:8787, signed in as the dev user
pnpm run deploy                                      # the same as pnpm everyapp deploy
```

```text
Live          https://my-app.apps.yourcompany.com
Who can open  Private to you, owners and admins · change it at https://apps.yourcompany.com/admin/apps
Public        Open to the internet without sign-in: GET /health
```

Open `apps/my-app` in Claude Code, Codex or Cursor and say what you want. The skill in `.agents/skills/everyapp` tells your agent the CLI, the manifest and the rules, so it never writes a login page. `apps/my-app` is yours: git in your `every-app` folder neither tracks nor ignores it, and `git pull` leaves it alone. For a repository of its own, run `pnpm everyapp create my-app` from a folder outside `every-app`.

- One AI key on the Gateway serves every app that declares that provider: `pnpm everyapp secret set OPENROUTER_API_KEY` covers OpenSEO, OpenCRM and Agentic Inbox (OpenAI and Workers AI work too).
- One MCP address, `https://apps.yourcompany.com/mcp`, connects claude.ai, ChatGPT, Claude Code and Cursor to your apps. Tools that delete data stay hidden from agents.

## Four apps on day one

Each is open source and runs behind your Gateway.

- [OpenSEO](https://github.com/every-app/open-seo) — SEO research, rank tracking, site audits and AI visibility for your sites. Bring your own DataForSEO key for the search data.
- [OpenCRM](https://github.com/every-app/open-crm) — companies, contacts and deals, kept up to date by a research agent.
- [OpenAnalytics](https://github.com/every-app/open-analytics) — web analytics for your sites: no cookies, no stored IP addresses, a tracker of about 3 KB gzipped.
- [Agentic Inbox](https://github.com/every-app/agentic-inbox) — a team inbox with an AI agent: receive, read, draft and send email on your own domain.

Clone one, run `pnpm install`, then `pnpm everyapp deploy` in its folder. None of the four publishes a release yet. Once one does (its author runs `pnpm everyapp release` and attaches the file to a GitHub release of the repository), `pnpm everyapp install <GitHub URL>` installs it straight from GitHub; run it again to update.

Fork one and vibe code your own.

## Security

The Gateway only gives apps what you allow. [docs/threat-model.md](docs/threat-model.md) says what is promised, to whom, where each promise is enforced and tested, and what is still open.

- Your credential stops at the Gateway. An app never sees a cookie or a token, only a short-lived signed note of who you are, made for that app alone.
- Your AI keys stay on the Gateway. An app declares what it needs and never holds a key.
- Apps have no public address of their own: every visit passes the Gateway. The only routes open without a sign-in are the ones an app declares public (a webhook, a tracking script), and the deploy prints them.
- Each app has its own database.

Anyone who can sign in to your Cloudflare account can deploy apps and change the Gateway. Only give that access to people you fully trust, and turn on two-factor for that account.

We strongly recommend Cloudflare Access before you invite anyone. The Gateway is alpha software; Access is a second, independent sign-in from a company that does nothing else, so a visitor never reaches the Gateway's sign-in pages, and a stolen session cookie is not enough on its own. `pnpm everyapp access on` puts it at Cloudflare's edge in front of the Gateway and your apps: a one-time code by email, or your company's identity provider. MCP and an app's public routes stay reachable, so AI clients keep working. Free for up to 50 people. See [Cloudflare Access](https://everyapp.com/docs/access).

## Alpha

Every App is alpha. It is very powerful, moving fast, and trying not to break things:

- A deploy keeps your data and saves a restore point before it changes an app's database on D1.
- Updating is `git pull`, `pnpm install`, then `pnpm everyapp update`.
- When something must change, the release notes say so.

No backwards-compatibility promise yet.

## Let your agent set it up

Paste this into Claude Code, Codex or Cursor:

```text
Set up Every App for me. Docs: https://everyapp.com/llms.txt (read index.md
and setup.md there; the everyapp skill in the repo says the same).

1. Clone https://github.com/every-app/every-app.git, run `pnpm install`,
   and run every command from that folder. Always `pnpm everyapp`, never npx.
2. Ask me which domain to use, then run
   `pnpm everyapp setup --domain apps.<my domain> --json`.
   Setup can run 20 minutes (it builds, deploys, waits for a certificate, then
   waits for me at the owner link): give it a long timeout or run it in the
   background and read its output.
3. When it is done, create and deploy one app:
   `pnpm everyapp create hello --json`, then from apps/hello
   `pnpm everyapp deploy --json`. Tell me its URL.

The --json output is one event per line. "type":"action_required" means I
have to do something: show me its message, data.url and data.code, then wait
("waiting": true means keep reading, up to 15 minutes). Exit code 2 means
stopped for me: once I say done, run its data.rerun exactly as given (it
already has --json), or one of data.choices[].rerun if I have to pick the
account; if data.needsTerminal is true, give me the command to run myself,
without --json. Exit 1 is an error: show me its code and fix.

Only I can approve the Cloudflare login, pick the Cloudflare account if I
have several, create the owner account from the setup link, pick a
workers.dev name (my apps never use it), pay for Workers Paid, buy a domain,
or confirm in a terminal a Worker changed outside everyapp. Keep it short.
When everything is done print DONE and the Gateway URL; if stuck print
BLOCKED: <why> and stop.
```

Never `npx everyapp`: publishing to npm is paused, and the old version there cannot deploy this Gateway.

## Help

- `pnpm everyapp status` says what is wrong and what to run.
- If setup or a deploy stops, run it again: it picks up where it left off.
- [Troubleshooting](https://everyapp.com/docs/troubleshooting): find the message you saw.
- [Join Discord to chat](https://discord.gg/c9uGs3cFXr)
- Made by [Ben Senescu](https://x.com/bensenescu), who also makes [openseo.so](https://openseo.so), and contributors.
- Security holes: report them privately, not in a public issue ([how](docs/threat-model.md#reporting-a-problem)). A failing test is the best report. No bounty.

## License

MIT, see [LICENSE](LICENSE).
