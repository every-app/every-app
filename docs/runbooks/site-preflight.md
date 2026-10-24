# Site preflight: everyapp.com before and after a deploy

The landing page (`landing-page/`: the home page, the user docs at `/docs`, the agent docs at `/docs/agent`, `/llms.txt` and `/llms-full.txt`) is deployed by hand with `pnpm -C landing-page deploy`, and only by Ben. This runbook is the check that runs before that deploy, against the local build, and again right after it, against the live site. Both runs are the same script, `landing-page/scripts/preflight.js`; it has no dependencies and takes the site's origin as its argument.

## Before the deploy: the local build

From a checkout of `main` with nothing uncommitted:

```bash
pnpm install --frozen-lockfile
pnpm -C landing-page build
pnpm -C landing-page exec vite preview --port 4322 --strictPort &
pnpm -C landing-page preflight            # crawls http://localhost:4322
```

Expected: `0 errors, 0 warnings`, after lines like `41 HTML pages, 3251 internal links`, `39 Markdown twins` and `/llms-full.txt is 1.56 MB` (the counts grow with the docs). The script exits 1 on any error, so a shell `&&` chain stops there. An error is something a visitor or a coding agent would hit; fix it on `main` first and build again. A warning is cosmetic (a page missing from the sitemap, a docs page without a description); fix it or go on.

## After the deploy: the live site

```bash
pnpm -C landing-page preflight https://everyapp.com --external
```

Expected: `0 errors`. With `--external` the script also fetches every link that leaves the site (Cloudflare's docs, GitHub, the Discord invite, nodejs.org); a failure there is a warning with the page it came from, since other sites have bad days. A `403` or `429` means the site refused a script, not that the link is broken: open it in a browser.

Then by hand, since a script can't:

- `curl -sI https://www.everyapp.com/docs` and `curl -sI https://everyapp.dev/docs` answer `301` with `location: https://everyapp.com/docs` (the redirect Worker in `landing-page/redirect`, deployed separately with `pnpm -C landing-page deploy:redirect`; it rarely changes).
- Open `https://everyapp.com/` and `https://everyapp.com/docs` on a phone, or in a window about 390 px wide: the hero wraps, the docs sidebar collapses into the menu, nothing overflows sideways. Switch the docs between light and dark with the toggle at the top of the sidebar; the home page is dark by design.
- On `https://everyapp.com/docs/gateway`, the setup prompt under "Or let your coding agent do it" is one code block with a copy button, and what it copies is `landing-page/content/docs/setup-prompt.txt` word for word (the same text `packages/onboarding-loop/prompts/setup.md` holds; `packages/onboarding-loop` has a test that fails when the two differ).
- The search box on any docs page finds "Access".
- Leave an address in the home page's "Keep me posted" form: it answers "Thanks. We'll keep you posted." (it writes to the `waitlist_signups` table of the landing page's D1 database, which `pnpm -C landing-page deploy` migrates first).
- Paste `https://everyapp.com/` and one docs page into a link preview debugger (Slack, X, or opengraph.xyz): the title, the description and `/OpenGraphPreview.png` show.
- The browser console on the home page and on `/docs` shows no errors (the analytics `collect` request may show as cancelled when the page is left; that is the beacon, not an error).

## What the script checks

- `/robots.txt` answers and names `/sitemap.xml`; the sitemap lists only pages on this site.
- Every page in the sitemap, `/privacy`, and every page reached by following links from `/` answers `200` as HTML, has a `<title>`, a description, `og:title`, `og:url` and a canonical link under `https://everyapp.com`, and the canonical names the page itself.
- Every internal link resolves with a `200` and no redirect, and a link with an anchor points at an `id` the target page has (the table of contents, cross-page anchors, the error codes). Every page that was crawled is in the sitemap.
- Every docs page's Markdown twin (`/docs/gateway.md`, `/docs/agent/index.md`) answers `200` as `text/markdown`, starts with its title line, carries no MDX comment or unexpanded include, and its own links resolve.
- `/llms.txt` answers as plain text with a "User guides" and an "Agent docs" section, lists every docs page, and every URL in it resolves. `/llms-full.txt` carries every user page and every agent page outside `repo/`, none of the mirrored repository documents, and no MDX comment.
- `/docs/internal`, `/docs/internal.md`, an unknown agent page and an unknown path answer `404`. The old docs slugs (`/docs/quickstart`, `/docs/introduction`, `/docs/reference/cli`) redirect to their new pages.
- No page says what the site must no longer say: the private repository's name, `TODO(publishing)`, the old CLI verbs (`gateway deploy`, `--bundle-only`, the `workflow` group), "waitlist" on the home page; and as warnings, `examples/`, the mobile app and Postiz presented as current on the home page or the user docs.
- Every `github.com/every-app/every-app/blob/main/<path>` link on the site names a file the checkout the script runs from has.

Add a check to the script when a deploy teaches us a new way for the site to be wrong; the list above is the contract.
