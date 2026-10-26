# EveryApp

> Make every app open source

Legacy SaaS tools are bloated, expensive and don't work well with agents.

Now it's clear that, eventually, everything will be open source. The only questions are: How soon and how will everything work together?

> The backend for your agents

The Gateway takes the friction out of getting personal web apps and agents off localhost. You can manage everything through your agent. 

Set it up once, then self-host open source apps and personal software, all behind one secure sign-in.

[![EveryApp app launcher, OpenSEO, and secure Gateway demo](docs/assets/everyapp-demo.gif)](https://youtu.be/krDediTp0MI)

## Who are you?

We're the team behind [OpenSEO](https://github.com/every-app/open-seo), the open source alternative to Semrush and Ahrefs (25k stars).

## Why use EveryApp?

**Secure by default**

- Every request passes through the Gateway. Apps have no public address.
- Connect an API once. Apps ask for access, and the Gateway makes the call, so no app ever holds your keys.
- Don't trust us? Good. Put it all behind [Cloudflare Access](https://everyapp.com/docs/access).

**Scales from zero to infinity**

- Fully serverless, in your own Cloudflare account.
- An app nobody uses costs $0.
- $5/month for Cloudflare's Workers Paid plan hosts hundreds of apps.

**Standardized**

- No infra decisions. Every app runs on Cloudflare's building blocks: Workers, D1, R2 and KV.
- Your agent builds with our stack and component library, so it never has to invent patterns.

## Apps

- [OpenSEO](https://github.com/every-app/open-seo): SEO research, rank tracking, site audits and AI visibility for your sites.
- [OpenCRM](https://github.com/every-app/open-crm): Companies, contacts and deals, kept up to date by a research agent.
- [OpenAnalytics](https://github.com/every-app/open-analytics): Web analytics for your sites. No cookies, no stored IP addresses.
- [OpenMail](https://github.com/every-app/open-mail): A team inbox with an AI agent that reads, drafts and sends email on your domain.

Run one as it is, or fork it as the starting point for your own. Many more are coming.

## Get started

You need a Cloudflare account on Workers Paid ($5/month) and a domain on Cloudflare. Setup takes about 15 minutes.

```bash
git clone https://github.com/every-app/every-app.git
cd every-app
pnpm install
pnpm everyapp setup --domain apps.yourcompany.com
```

Or [paste one prompt into Claude Code, Codex or Cursor](https://everyapp.com/docs/gateway#or-let-your-coding-agent-do-it) and let it set everything up.

Then install an app with `pnpm everyapp install https://github.com/every-app/open-seo`, or [build your own](https://everyapp.com/docs/create-an-app) with `pnpm everyapp create ../my-app`.

Always `pnpm everyapp` from the checkout, never `npx everyapp`: publishing to npm is paused.

## What's on the roadmap?

Oh, nothing much. Just rebuilding every SaaS for agents.

⭐ Star the repo to follow along.

## Community

- Docs: [everyapp.com/docs](https://everyapp.com/docs) (for your agent: [everyapp.com/llms.txt](https://everyapp.com/llms.txt))
- Join [Discord](https://discord.gg/c9uGs3cFXr) to chat
- Security holes: report them privately, not in a public issue ([how](docs/threat-model.md#reporting-a-problem)).

## License

MIT, see [LICENSE](LICENSE).
