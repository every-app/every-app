# Every App

> Make every app open source

Own your tools. Customize your tools.

Pay as you go.

Build internal apps with peace of mind.

Every App puts the web apps you build online, in your own Cloudflare account. Each app gets a web address, a database and a sign-in. One Gateway sits in front of them all and gives each app only what you allow. Made for a solo founder or a team of three or four who build their own tools with Claude Code, Codex or Cursor.

Two ways to use it:

- Four open-source apps, built for your Gateway: OpenSEO, OpenCRM, OpenAnalytics and Agentic Inbox. Run one as it is, or fork it as the starting recipe for your own. [Apps off the shelf](#apps-off-the-shelf)
- The Gateway at `apps.yourcompany.com` is the home base where you and your team build internal apps. One sign-in, invite only, no login page in any app. Your coding agent does most of the building. [The Gateway, your home base](#the-gateway-your-home-base)

Free and open source, MIT. You pay Cloudflare: Workers Paid, $5 a month, then usage; a few apps for a small team fit inside it. Setting up your Gateway takes about 15 minutes. [How you start](#how-you-start)

Very powerful, and alpha. Powerful: your apps run in your Cloudflare account with everything it can do. Alpha: moving fast, and trying not to break things. A deploy keeps your data and saves a restore point first. [Alpha](#alpha)

We strongly recommend Cloudflare Access before you invite anyone. `pnpm everyapp access on` adds a second sign-in at Cloudflare's edge, in front of the Gateway and your apps. Free for up to 50 people. [Cloudflare Access](https://everyapp.com/docs/access)

## Apps off the shelf

- [OpenSEO](https://github.com/every-app/open-seo): SEO research, rank tracking, site audits and AI visibility for your sites.
- [OpenCRM](https://github.com/every-app/open-crm): Companies, contacts and deals, kept up to date by a research agent.
- [OpenAnalytics](https://github.com/every-app/open-analytics): Web analytics for your sites. No cookies, no stored IP addresses.
- [Agentic Inbox](https://github.com/every-app/agentic-inbox): A team inbox with an AI agent that reads, drafts and sends email on your domain.

Set up your Gateway first ([How you start](#how-you-start)). Then clone one, run `pnpm install`, and run `pnpm everyapp deploy` in its folder. OpenSEO needs a DataForSEO key, OpenCRM a Context.dev key, OpenAnalytics a secret of its own. The three that use AI share one key on the Gateway: `pnpm everyapp secret set OPENROUTER_API_KEY`.

None of the four publishes a release yet. Once one does, `pnpm everyapp install <GitHub URL>` installs it from GitHub; run it again to update. Your Gateway's home shows the four apps and a Build your own card.

## The Gateway, your home base

You and the people you invite sign in at `apps.yourcompany.com` and open your apps there. The Gateway gives each app only what you allow:

- Your credential stops at the Gateway. An app never sees a cookie or a token, only a short-lived signed note of who you are, made for that app alone.
- Your AI keys stay on the Gateway. An app declares what it needs and never holds a key.
- Apps have no public address of their own: every visit passes the Gateway. The only routes open without a sign-in are the ones an app declares public (a webhook, a tracking script), and the deploy prints them.
- Each app has its own database.
- One MCP address, `https://apps.yourcompany.com/mcp`, connects claude.ai, ChatGPT, Claude Code and Cursor to your apps. Tools that delete data stay hidden from agents.

[docs/threat-model.md](docs/threat-model.md) says what is promised, to whom, where each promise is enforced and tested, and what is still open.

Anyone who can sign in to your Cloudflare account can deploy apps and change the Gateway. Only give that access to people you fully trust, and turn on two-factor for that account.

We strongly recommend Cloudflare Access before you invite anyone. The Gateway is alpha; Access is a second, independent sign-in from a company that does nothing else. A visitor never reaches the Gateway's sign-in pages, and a stolen session cookie is not enough on its own. It asks for a one-time code by email, or your company's identity provider. MCP and an app's public routes stay reachable, so AI clients keep working. [Cloudflare Access](https://everyapp.com/docs/access)

## How you start

### What you need

- Node.js 22.18 or newer, pnpm and git. Your coding agent can install them for you; by hand, see [Install the tools](https://everyapp.com/docs/gateway#install-the-tools).
- A Cloudflare account on Workers Paid: $5 a month, then usage. The $5 includes 10 million requests and 25 billion database reads a month, and an app adds no fixed cost; past that, Cloudflare bills by use ([its pricing page](https://developers.cloudflare.com/workers/platform/pricing/) has the rates).
- A domain on Cloudflare: buy one there (a `.com` is about $10 a year, a `.dev` or `.app` $1 the first year) or bring one you already own. [Get a domain](https://everyapp.com/docs/domain)

The docs are at https://everyapp.com/docs.

### Your first app

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

Open `apps/my-app` in Claude Code, Codex or Cursor and say what you want. The `everyapp` skill in every app tells your coding agent the CLI, the manifest and the rules, so it never writes a login page. `apps/my-app` is yours: git in your `every-app` folder neither tracks nor ignores it, and `git pull` leaves it alone. For a repository of its own, run `pnpm everyapp create my-app` from a folder outside `every-app`.

### Or let your agent set it up

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
4. Then install the four Every App apps unless I say which to skip. Ask me
   once: "I'll install OpenSEO, OpenCRM, OpenAnalytics and Agentic Inbox.
   Any you don't want?" For each one I keep, run
   `pnpm everyapp install https://github.com/every-app/<repo> --json` with
   open-seo, open-crm, open-analytics or agentic-inbox as <repo>. If an
   install answers NO_RELEASE, say which app and continue; do not try to
   build it from source. An app that needs keys shows Needs setup on the
   Gateway: tell me which keys it wants and stop there.

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

## Alpha

Every App is alpha. It is very powerful, moving fast, and trying not to break things:

- A deploy keeps your data and saves a restore point before it changes an app's database on D1.
- Updating is `git pull`, `pnpm install`, then `pnpm everyapp update`.
- When something must change, the release notes say so.

No backwards-compatibility promise yet.

## Help

- `pnpm everyapp status` says what is wrong and what to run.
- If setup or a deploy stops, run it again: it picks up where it left off.
- [Troubleshooting](https://everyapp.com/docs/troubleshooting): find the message you saw.
- [Join Discord to chat](https://discord.gg/c9uGs3cFXr)
- Made by [Ben Senescu](https://x.com/bensenescu), who also makes [openseo.so](https://openseo.so), and contributors.
- Security holes: report them privately, not in a public issue ([how](docs/threat-model.md#reporting-a-problem)). A failing test is the best report. No bounty.

## License

MIT, see [LICENSE](LICENSE).
