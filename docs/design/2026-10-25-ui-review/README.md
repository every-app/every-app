# UI review, 2026-10-25

The design review of the Every App gateway two days before launch: real screenshots of every key flow and state, each with a caption and a designer's critique, and a ranked list of fixes. Open [index.html](index.html) in a browser (GitHub does not render it).

How it was made: a local gateway on main (1b424eac) seeded with `apps/every-app-gateway/scripts/seed-local.mjs`, walked as owner, admin, member, signed out and behind the mock Cloudflare Access ring (`scripts/access-local.mjs`), light and dark, 1440 and 390 wide; the terminal captured from the real CLI (help, logged-out states), the real `status` and `deploy` renderers over the CLI's fake Cloudflare account, and the setup-skills fake for `setup`. One reviewer per flow wrote the critique from the images; every finding faced two refuters before ranking. Nothing deployed, nothing live touched.

The five to hear first:

1. Ask for the organization name on the claim form
2. Setup dialog: name both email settings, explain next step, never split names
3. Admin → Apps: strip developer strings, rename Access, explain 'Available to everyone'
4. Sign-in: Sign up only when open; behind Access one alert, no SSO
5. Give empty AI connections the way in; point Documentation at docs

The full list, with effort and code pointers, is in TODO.md under "UI review (2026-10-25)". Images: `images/` holds the shots shown in full, `images/thumbs/` the rest of the captures at thumbnail size.
