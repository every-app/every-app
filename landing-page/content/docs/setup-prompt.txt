Set up EveryApp for me. Docs: https://everyapp.com/llms.txt (read index.md
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
4. Then install the four EveryApp apps unless I say which to skip. Ask me
   once: "I'll install OpenSEO, OpenCRM, OpenAnalytics and OpenMail.
   Any you don't want?" For each one I keep, run
   `pnpm everyapp install https://github.com/every-app/<repo> --json` with
   open-seo, open-crm, open-analytics or open-mail as <repo>. If an
   install answers NO_RELEASE, say which app and continue; do not try to
   build it from source. If it answers R2_NOT_ENABLED, ask me to enable
   R2 in the Cloudflare dashboard (once), wait, then run it again. An app
   that needs keys shows Needs setup on the Gateway: tell me which keys it
   wants and stop there.

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
enable R2 in the dashboard once, or confirm in a terminal a Worker changed
outside everyapp. Keep it short.
When everything is done print DONE and the Gateway URL; if stuck print
BLOCKED: <why> and stop.
