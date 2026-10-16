# Round 2: transactional email, and the legal and abuse minimums

Date: 2026-10-15. Gap-filling report for the hosted research round. Code refs
are to `origin/main` (PRs #284-#294 merged) unless marked `e1d9d3c6`. Web
sources carry the date shown on the page, or "read 2026-10-15" when the page
shows none. This is writing and engineering input, not legal advice.

---

## 1. The question

**(A) Email.** Hosted sign-up needs email: verification (README H9, D12
"hard email verification"), invitations, password resets, billing and
suspension notices. No provider was chosen. Which provider for hosted, which
for self-host (what is `EMAIL_REST_API_TOKEN` today?), what DNS does
`everyapp.com` need (the marketing Worker owns the apex), and how big is the
PR?

**(B) Legal and abuse.** No report covered the documents and channels a
platform that hosts strangers' code needs: Terms, an acceptable use policy
(AUP), a privacy policy that matches what the broker logs, a subprocessor
list, an abuse channel, a phishing and DMCA takedown process, and what
Cloudflare requires of a platform built on Workers for Platforms. What must
exist before the first outside org, and what before public sign-up? Who
drafts it (D16)?

---

## 2. Findings with sources

### A. Email

**A1. Self-host and hosted already share one transport: Cloudflare Email
Sending.**
- `apps/every-app-gateway/src/server/email/sendEmail.ts:85-171,190-209`
  sends through the Email Sending REST endpoint
  `POST /accounts/{id}/email/sending/send` when `EMAIL_REST_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID` are set, else through the `EMAIL` `send_email`
  binding (`cloudflare.config.ts:132`).
- So `EMAIL_REST_API_TOKEN` is a **Cloudflare API token with the Email
  Sending permission**, used by Docker self-host because its local binding
  only writes `.eml` files (`docs/runbooks/email-sending-setup.md:6-12,44-51`).
  Deployed gateways use the binding and need no token.
- Email is optional. Without a sender, invitations and resets become links
  the admin copies (`isEmailConfigured()`, `sendEmail.ts:173-188`;
  `InvitationService.ts:30-56`).
- Templates are inline strings: the reset email (`auth/config.ts:294-301`)
  and the invitation (`InvitationService.ts:40-48`). Nothing is escaped.

**A2. OpenSEO uses Loops, not Cloudflare.**
- `open-seo/src/server/email/loops.ts:7-179`: verification, password reset
  and invitation through Loops transactional templates (`transactionalId` +
  `dataVariables`). Contacts are synced at sign-up (`upsertHostedSignupContact`).
- `open-seo/src/server/email/loops-client.ts:49-75`: Loops events with an
  `Idempotency-Key` (409 on replay counts as success) drive lifecycle
  workflows.
- `open-seo/specs/0015-billing-lifecycle-emails.md`: three billing moments
  (subscribed + a one-week check-in, payment failed, cancelled) are Loops
  events, derived by diffing Autumn customer snapshots. Loops owns timing and
  copy, including an audience filter before the check-in.
- DNS: OpenSEO sends from `mail.openseo.so`; `envelope.mail.openseo.so` MX
  points to `feedback-smtp.us-east-1.amazonses.com` (Loops sends through SES).
  `dig`, 2026-10-15.

**A3. Cloudflare Email Sending, as of 2026-10-15.**

| Fact | Value | Source |
|---|---|---|
| Status | **Public beta** since 2026-04-16 | changelog `2026-04-16-email-sending-public-beta`; `/email-service/` (updated 2026-10-15): "Email Sending Beta" |
| Plan | Arbitrary recipients need **Workers Paid**. Sends to verified destination addresses are free on every plan | `/email-service/` (2026-10-15); `/email-service/platform/pricing/` (2026-06-09) |
| Price | 3,000 included per account per month, then **$0.35 per 1,000**. Hard bounces count; sends rejected at the API, including suppressed ones, do not | pricing page (2026-06-09) |
| New accounts | "start with a conservative daily quota and scale up over time"; increases by form. Terms: Cloudflare "may initially limit new accounts to a 'Sandbox' environment" | `/email-service/platform/limits/` (2026-09-25); Developer Platform Service-Specific Terms, Email Service §4 (2026-09-28) |
| Per message | 50 recipients across to/cc/bcc; 5 MiB including attachments; 32 attachments | limits page; Workers API error table (2026-10-15) |
| Domains | 30 Email Routing + Email Sending domains per zone; the domain must use Cloudflare DNS and be in your account | `/email-service/configuration/subdomains/` (2026-10-15); `/email-service/get-started/send-emails/` |
| DNS it writes | On the onboarded domain `D`: MX `cf-bounce.D` → `route1/2/3.mx.cloudflare.net`; TXT `cf-bounce.D` `v=spf1 include:_spf.mx.cloudflare.net ~all`; TXT `cf-bounce._domainkey.D` (DKIM); TXT `_dmarc.D`. The records are locked once onboarding succeeds | `/email-service/configuration/domains/` |
| Subdomains | "Email Sending treats a subdomain as a separate sending domain"; Cloudflare recommends `notifications.` for transactional and `marketing.` for promotional mail, each with its own reputation | subdomains page; `/email-service/concepts/deliverability/` (2026-09-16) |
| Bounces | Automatic suppression of hard bounces and complaints, scoped per sending domain. A send to a suppressed address fails with `E_RECIPIENT_SUPPRESSED` unless "Drop suppressed recipients" is on (off by default) | `/email-service/concepts/suppressions/`; Workers API error codes (2026-10-15) |
| Events | **Queues event subscriptions** (2026-07-15): `message.delivered`, `deferred`, `bounced`, `failed`, `rejected`, `complained`, one subscription per sending domain, with SMTP status and bounce classification | changelog `2026-07-15-event-subscriptions`; `/queues/event-subscriptions/events-schemas/` |
| Logs | Activity log, 30 days in the dashboard; GraphQL `emailSendingAdaptive` | `/email-service/observability/logs/` (2026-10-15) |
| Headers | `List-Unsubscribe` and `List-Unsubscribe-Post` allowed; any `X-` header allowed; others refused (`E_HEADER_NOT_ALLOWED`) | `/email-service/reference/headers/` (2026-08-25) |
| Templates | None hosted: you send rendered `html` and `text` | Workers API and REST pages |
| Binding restriction | `allowed_sender_addresses` / `allowedSenderAddresses` limit the `From` a binding may use | `/email-service/configuration/send-bindings/` (2026-10-15); cf config explorer |
| Deliverability targets | Delivery >95%, hard bounce <2%, complaint <0.1% | deliverability page |

**What the terms allow** (Developer Platform Service-Specific Terms, Email
Service section, updated 2026-09-28,
https://www.cloudflare.com/service-specific-terms-developer-platform/):
- §1: only "with domains or email addresses that you own" and "to send email
  messages sent in response to a specific customer interaction to facilitate
  an agreed-upon transaction". That is **transactional mail only**.
- §2: "you may not use the Email Service to send unsolicited messages", and
  must follow mailbox-provider guidelines and commercial email law.
- §3: Cloudflare sets bounce and complaint thresholds and may put the account
  under "Review" or throttle it. The scope is the **account**, so one tenant
  abusing invitations can slow verification email for every sign-up.
- §5: Cloudflare scans email content and may drop messages.

Founder check-ins and product news are not "a specific customer interaction",
so they don't belong on Cloudflare Email Sending. That is the main reason to
keep Loops for lifecycle mail.

**A4. Alternatives, from each vendor's pricing page (read 2026-10-15).**

| | Cloudflare Email Sending | Resend | Postmark | Amazon SES | Loops (today, OpenSEO) |
|---|---|---|---|---|---|
| Free | None for arbitrary recipients (needs Workers Paid, already paid) | 3,000/mo, **100/day**, 3 domains | 100/mo | $200 credits for new AWS accounts; sandbox: verified recipients only, 200/24 h, 1/s until a review (initial response within 96 h) | 1,000 contacts, 4,000 sends per rolling 30 days |
| First paid | $0.35/1,000 after 3,000 | Pro $20/mo for 50k; $0.90/1,000 overage | Basic $15/mo for 10k; $1.80/1,000 | $0.10/1,000 | Growth $49/mo for 5,000 contacts, "Unlimited transactional sends" |
| Bounce/complaint feed | Queues event subscriptions | Webhooks (1 endpoint on Free, 5 on Pro) | Webhooks (official docs not fetched; third-party guides list Bounce and SpamComplaint) | Not fetched (UNVERIFIED) | In the Loops dashboard |
| Templates | None (render in code) | Not stated on pricing page | Yes | Not fetched | Yes |
| Marketing allowed | No (terms §1-§2) | Separate marketing plans | Separate "broadcast" stream | Yes, declared at production review | Yes (its main use) |
| New vendor / subprocessor for hosted | No (Cloudflare is already the host) | Yes | Yes | Yes | Already in OpenSEO's privacy policy |

Sources: https://resend.com/pricing, https://postmarkapp.com/pricing,
https://aws.amazon.com/ses/pricing/,
https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html,
https://loops.so/pricing (all read 2026-10-15).

**A5. DNS today** (`dig`, 2026-10-15):
- `everyapp.com`: MX `0 .` (null MX), TXT `v=spf1 -all`, **no DMARC**; NS on
  Cloudflare. Matches `TODO.md:82` ("keeping the apex null MX and
  `v=spf1 -all` TXT until email is set up").
- `everyapp.dev`: Proton MX, `v=spf1 include:_spf.protonmail.ch ~all`, three
  Proton DKIM CNAMEs, and **two `_dmarc` TXT records**
  (`p=none; rua=…@dmarc-reports.cloudflare.net` and `p=quarantine`). RFC 7489
  §6.6.3 step 5: "If the remaining set contains multiple records or no
  records, policy discovery terminates", and DMARC is not applied. So
  `everyapp.dev` effectively has no DMARC today. Deleting one record fixes it
  (5 minutes).
- `notify.everyapp.dev`: Resend (`resend._domainkey`, `send.` MX to SES
  feedback), as `TODO.md:85` says. No code in this repo sends through it
  (`git grep` on main).
- `openseo.so`: Google Workspace MX, Proton plus Google SPF, DMARC
  `p=reject` with Cloudflare DMARC reports.

**A6. The invitation email is a phishing relay once strangers can name
orgs.**
- `InvitationService.ts:40-48` puts `organization.name` into the subject,
  text and HTML, and `inviterEmail` into the HTML, all unescaped. Today the
  org name comes from the setup claim (`routes/api/setup/claim.ts:13`, 1-120
  characters, any content), so only the owner controls it. In hosted, anyone
  who signs up names an org (H9) and can invite any address.
- This exact abuse is in the wild:
  - Fake OpenAI organizations named after real companies sent team invites
    from OpenAI's own address, passing authentication (BleepingComputer,
    2026-06-26,
    https://bleepingcomputer.com/news/security/cybersecurity-firms-targeted-by-fraudulent-openai-organization-invites).
  - Check Point counted about 133,260 phishing emails to about 20,049
    organizations. They carried scam text in user-controlled name and
    business fields of Zoom, PayPal, Microsoft and Amazon Business
    notifications (2026-02-05,
    https://blog.checkpoint.com/research/saas-abuse-at-scale-phone-based-scam-campaign-leveraging-trusted-platforms/).
- Under Email Service terms §3, the resulting complaints land on our
  **account**, the same one that sends every verification email.

**A7. The `everyapp.com` zone has to sit in the account that sends.**
- Email Sending onboards "a domain from your Cloudflare account"
  (get-started page), and a Workers Custom Domain cannot be created "on a
  zone you do not own" (`/workers/configuration/routing/custom-domains/`,
  2026-09-29).
- D1's control plane `app.everyapp.com` and a `mail.everyapp.com` sender
  therefore both need the zone in the hosted account (D7: a new account).
  The marketing Worker on the apex would move with it.
- The alternative is to leave the zone where it is and send through REST
  with a narrowly scoped token from the zone's account. `sendEmail.ts`
  already supports that, but `app.everyapp.com` would still need the zone.
  This belongs in D7, not in an email decision.

### B. Legal and abuse

**B1. What exists.**
- OpenSEO has full documents published by **Every App, Inc**:
  - Terms (`open-seo/web/content/legal/terms-and-conditions.md`, revised
    2026-08-23, ~7,200 words): an AUP (§3.3), enforcement (§3.4),
    indemnity (§4), termination (§8), a DMCA policy naming a designated
    agent (§9), and JAMS arbitration with a 30-day opt-out (§10.2). It
    carves out self-hosted and MIT copies.
  - Privacy policy (`open-seo/web/content/legal/privacy.md`, 2026-08-24):
    it names its vendors (Loops, Plausible, PostHog, Dub, Autumn, Stripe,
    Cloudflare, DataForSEO, OpenRouter, OpenAI) and has a Google API
    Limited Use section.
  - A GDPR erasure runbook (`open-seo/docs/maintainers/runbooks/gdpr-erasure.md`).
- Every App has one page, `everyapp.com/privacy`
  (`landing-page/src/routes/privacy.tsx`), written for the iOS app. It is
  attributed to "Ben Senescu" and says "We do not operate any servers that
  receive your data" (`:36-37`). That becomes false the day the hosted
  gateway serves anyone, including from the iOS app. There are no Terms,
  AUP or abuse pages. `support@everyapp.dev` is the only published contact
  (`landing-page/src/routes/support.tsx:35-38`).
- The OpenSEO Terms don't cover what hosted adds: customers deploying code,
  public routes, a metered AI and data broker, prepaid credits across apps,
  and org data processed on the customer's behalf.

**B2. Cloudflare's requirements for a platform running End Users' code.**

From the Developer Platform Service-Specific Terms (2026-09-28,
https://www.cloudflare.com/service-specific-terms-developer-platform/):
- §3: "You acknowledge and agree that you are solely responsible for the acts
  of your End Users." We carry support and liability toward them, and
  Cloudflare "may, but is not obligated to, limit or suspend your or your End
  Users access", possibly without notice.
- §4: no "viruses, adware, spyware, worms, crypto-mining software or other
  malicious code"; no "volumetric attacks".
- §6: no subdomains with "deceptive or offensive terms", including other
  businesses' names; "The use of the Services for phishing schemes is
  prohibited"; Cloudflare may suspend the account or project immediately.
  Tenant app hostnames `{app}-{orgKey}.<content domain>` are subdomains we
  create, so a tenant app called `paypal-login` is our violation.
- §8: the Developer Platform "can be used to host content". Cloudflare may
  block or remove illegal or harmful content (CSAM, IP infringement,
  malware).
- §10: Workers for Platforms may be offered "for use by your End Users",
  provided their use "complies with the requirements and restrictions set
  forth in the Agreement". In other words, the whole Agreement flows down to
  our tenants.

From the Self-Serve Subscription Agreement (updated 2025-09-12,
https://www.cloudflare.com/terms/):
- §2.2.1(i): no storing or transmitting protected health information.
- §2.2.1(j): no "virtual private network or other similar proxy services".
- §8: Cloudflare may suspend or terminate "upon receiving any number of DMCA
  notifications" or on learning "you are a repeat infringer". DMCA notices
  about our tenants are notices about **our** account.

From the abuse approach page
(https://www.cloudflare.com/trust-hub/abuse-approach/, read 2026-10-15): for
hosted content (Workers, Pages, KV), Cloudflare "will remove or disable
access to that content" and "generally also notify the website operator". It
follows DMCA notice and counter-notice for copyright. Nothing says Cloudflare
forwards reports to us first, so our own intake must be faster than
Cloudflare's.

**B3. Upstream terms that flow down.**

OpenRouter Terms (2026-08-31, https://openrouter.ai/terms):
- §5.1 allows "your customers (to the extent you incorporate the Service into
  your own products and services)".
- §5.1-§5.5 make us responsible for customers complying with each model's
  terms.
- §7 item 4 forbids "reselling API access to Models or otherwise developing a
  competing service"; item 14 forbids selling or transferring "the access
  granted under these Terms".

Catalog apps that use AI are clearly "incorporating". A generic, metered,
OpenAI-compatible proxy that org apps (custom code) can call at a 1.28×
markup is closer to the §7 line. This is not settled (see §6, R25).

DataForSEO's terms (2026-06-12, https://dataforseo.com/terms-of-service)
contain no resale clause. §7.1 forbids using data "to compete with or
adversely affect the business interests of the search engine providers".

**B4. What hosted would actually store, from code (the privacy policy must
match).**

| Data | Where | Retention today | Source |
|---|---|---|---|
| Name, email, password hash, email-verified flag | D1 `users`, `accounts` | Life of account | `db/auth.schema.ts:10-14` |
| Session IP address and user agent | D1 `sessions` | Until session expiry | `db/auth.schema.ts:44-45` |
| Org, membership, invitations (invitee email) | D1 | Life of org; D12 adds a 7-day grace | `auth.schema.ts:109-150` |
| MCP tool-call audit: tool name, decision, duration, **keyed digest of arguments**, result size; never arguments or results | D1 `mcp_tool_calls` | 90 days default (`MCP_AUDIT_RETENTION_DAYS`) | `db/mcp.schema.ts:145-175`; `mcp-auth/maintenance.ts:4,128` |
| AI usage: tokens, model, org/app/user (hosted adds cost) | Workers Logs today; `OrgWallet` + `usage_daily` in H13 | 7 days (Workers Logs, Paid) | `ai-usage.ts:1-7` ("Prompts and outputs are never logged"); Workers Logs limits page |
| Prompts and outputs | Not stored by the gateway. AI Gateway logs them **unless** `cf-aig-collect-log-payload: false` or `collect_logs: false`. The draft backstop config in `raw/ai-gateway-and-openrouter-metering.md:655` sets `collect_logs: true` | — | AI Gateway logging doc (2026-03-17 changelog), quoted in that report §2.1.6 |
| Prompts at OpenRouter | "OpenRouter does not store your prompts or responses, unless you opt in"; it stores token and latency metadata; "If you opt out of training … OpenRouter will not route to providers that train" | OpenRouter's policy | https://openrouter.ai/docs/guides/privacy/data-collection and `/logging` (read 2026-10-15) |
| App data of each org (D1 per app, DO storage, R2) | Org's own databases | Until org deletion; D1 Time Travel keeps 30 days (README B7) | — |
| Billing identity | Autumn and Stripe | Their policies | README D5 |

"Prompts never stored" (README D6) is therefore true only if three settings
hold: no request-body logging in the gateway (true today), AI Gateway payload
logging off, and the OpenRouter account's logging opt-in left off. The
privacy policy should promise exactly that: Every App does not store prompt
or response content; OpenRouter and the model provider process it under
their terms. It should not promise more.

**B5. Statutory and conventional channels.**
- **DMCA designated agent.** The § 512 safe harbor requires designating an
  agent with the Copyright Office. Fee: "$6 per designation, amendment, or
  resubmission". A designation "will expire and become invalid three years
  after it is registered". Alternate names (website addresses, app names)
  can be listed under one designation at no extra fee, and subdomains need
  no separate entry
  (https://www.copyright.gov/dmca-directory/faq.html, read 2026-10-15).
  OpenSEO's Terms name Benjamin Senescu at 34 Harding Street, Cambridge, MA.
  Whether Every App, Inc's designation exists and lists `everyapp.com` is
  UNVERIFIED.
- **CSAM.** 18 U.S.C. § 2258A(a)(1): a provider "shall, as soon as
  reasonably possible after obtaining actual knowledge" report to NCMEC's
  CyberTipline. §(f) imposes no duty to monitor. §(h)(1): a report is
  treated as a request to preserve the contents for 1 year
  (https://www.law.cornell.edu/uscode/text/18/2258A, read 2026-10-15).
- **security.txt.** RFC 9116 (2022): served at
  `/.well-known/security.txt` over HTTPS; `Contact` and `Expires` are the
  only required fields.
- **Role mailboxes.** RFC 2142 (1997,
  https://datatracker.ietf.org/doc/html/rfc2142) names `abuse@` for abuse
  reports and `postmaster@` for mail, the addresses mailbox providers and
  abuse desks try first.

---

## 3. Recommendation

### A. Email

**Default for hosted:**
- **Transactional mail goes through Cloudflare Email Sending**, through the
  `send_email` binding the gateway already declares. Sender: `Every App
  <noreply@mail.everyapp.com>`, `reply_to` `support@everyapp.com`. This
  covers verification, resets, invitations, payment-failed and low-balance
  notices, suspension and takedown notices, and deletion notices. Reasons:
  - Cloudflare already hosts everything, so there is no new vendor,
    subprocessor or DPA.
  - Self-host runs the same code path.
  - It costs almost nothing ($0.35/1,000 after 3,000).
  - It now has a bounce and complaint feed (Queues event subscriptions) and
    automatic suppression.
- **Lifecycle and founder mail goes through Loops**, reusing OpenSEO's
  account and porting spec 0015 as is. Cloudflare's terms allow
  transactional mail only, and Loops already owns the timing, audience
  filters and unsubscribes. Contacts carry over with OpenSEO's customers
  under D5.
- **Tenant apps never get `send_email`.** The CLI policy already refuses it
  (`landing-page/content/docs/troubleshooting.mdx:180`), and H10's allowlist
  must too. App-sent mail is a later broker capability with per-org quotas,
  not a v1 item.
- **No second transactional provider for now.** `sendEmail.ts` is the seam.
  If R24 shows the new account's daily quota can't carry sign-ups, add a
  Resend transport behind the same function (Pro $20/mo for 50k): about
  0.5 d of code plus Resend's DNS records.

**Default for self-host:** unchanged. Cloudflare Email Sending through the
binding on Workers deployments, and the REST token (`EMAIL_REST_API_TOKEN` =
a Cloudflare API token with Email Sending permission) for Docker. On Workers
Free the copy-link fallback applies, which is already the documented
behavior. The escaping fix below lands for both modes.

**DNS for `everyapp.com`** (ops, about 1 hour, in the account that holds the
zone; see A7):

| Name | Type | Value | Why |
|---|---|---|---|
| `everyapp.com` | MX | `10 mail.protonmail.ch`, `20 mailsec.protonmail.ch` (replaces `0 .`) | Human mail (`support@`, `abuse@`, `security@`, `postmaster@`, `ben@`) on Proton, the same setup as `everyapp.dev` |
| `everyapp.com` | TXT | `v=spf1 include:_spf.protonmail.ch ~all` (replaces `v=spf1 -all`), plus Proton's verification TXT | Only Proton sends as the apex |
| `protonmail{,2,3}._domainkey` | CNAME | Proton-provided targets | Proton DKIM |
| `_dmarc.everyapp.com` | TXT | `v=DMARC1; p=none; rua=mailto:<id>@dmarc-reports.cloudflare.net` for two weeks, then `p=reject` | Same pattern `openseo.so` already runs at `p=reject` |
| `cf-bounce.mail.everyapp.com` | MX ×3, TXT SPF | written by Email Sending onboarding of `mail.everyapp.com` | Return-Path, SPF |
| `cf-bounce._domainkey.mail.everyapp.com` | TXT | written by onboarding | DKIM (`d=mail.everyapp.com`, aligned with the From) |
| `_dmarc.mail.everyapp.com` | TXT | written by onboarding (placement for a subdomain is UNVERIFIED) | — |

The marketing Worker on the apex is unaffected: these are MX and TXT
records, and the Worker is a Custom Domain on the A/AAAA record. Also delete
the duplicate `_dmarc.everyapp.dev` record, and file the Email Sending limit
increase on the hosted account the day it is created.

**PR size:**
- **In H9, +1 d** on top of the email verification it already lists:
  - one escaped template module: a layout, `escapeHtml` on every value, a
    text part, and a footer with "why you got this" and
    `everyapp.com/abuse`;
  - existing reset and invite templates moved onto it;
  - org names validated (length, no URLs, no `<>`);
  - invitations only from verified users, with a per-org daily budget in
    `rate_limit_counters`;
  - `E_RECIPIENT_SUPPRESSED`, `E_DAILY_LIMIT_EXCEEDED` and
    `E_RATE_LIMIT_EXCEEDED` mapped to typed errors with UI copy;
  - the binding restricted with `allowedSenderAddresses`.
- **In the new H27, 0.5 d:** a Queue event subscription on
  `mail.everyapp.com` for `message.bounced` and `message.complained`. It
  sets `users.email_undeliverable_at`, and a complaint on an invitation
  counts against the inviting org as a D10 abuse signal.
- **In H13/H19, 0.5-1 d:** the Loops lifecycle port (already implied by
  "port lifecycle emails from OpenSEO").

Total new work: about 1.5-2.5 d. Cost to change the provider later:
- Transactional: about 0.5 d of code, plus DNS and a few days of warm-up.
- Lifecycle: re-creating Loops workflows elsewhere, about 1 d.

### B. Legal and abuse: the checklist

Owners:
- **Agent**: drafts from OpenSEO's documents and the code facts in §2.
- **Ben**: decides, approves, registers and signs.
- **Counsel**: optional, reviews before public sign-up.

Sizes are writing or engineering days, agent-assisted.

| # | Item | Contents (minimum) | Owner | Size | First outside org | Public sign-up |
|---|---|---|---|---|---|---|
| L1 | **Terms of Service** (`everyapp.com/terms`) | Adapt OpenSEO's Terms (same entity) to cover: **customer apps and code** (customer owns and is responsible for it; we host it and may disable, replace or remove it; no SLA during the prototype); prepaid credits and holds (no refunds of used credits, expiry if any); AI output disclaimer; third-party services and model terms flowing down (OpenRouter §5.1-5.5); suspension for AUP or Cloudflare-terms violations; deletion (7-day grace, residual backups up to 30 days, D12); export promise; DMCA section listing the new domains; self-host and MIT carve-out; 18+; a short notice period for changes | Agent, Ben approves | 0.5 d | **Yes** (click-through stamped at sign-up and invitation acceptance) | Counsel review |
| L2 | **Acceptable Use Policy** (`/acceptable-use`) | Cloudflare's terms flowed down: no phishing or deceptive names (Dev Platform §6), malware or crypto-mining (§4), volumetric attacks, VPN or proxy services (Self-Serve §2.2.1(j)), PHI (§2.2.1(i)), IP infringement, CSAM; plus ours: no spam or unsolicited invitations, no reselling or proxying AI or data access (OpenRouter §7), no evading metering or limits, no scanning or attacks, no impersonating Every App or other orgs | Agent, Ben | 0.25 d | **Yes** | Yes |
| L3 | **Privacy Policy, hosted** (`/privacy`) | Inventory from §2 B4 with retention values; processor role for org app data; the precise prompts statement; OpenRouter and model providers named; email (Cloudflare, Loops); billing (Autumn, Stripe); Turnstile; cookies are strictly necessary only (gateway and landing page ship no analytics today); rights and contact; children; changes. Move the iOS-app page to `/privacy/ios` and fix its "no servers" sentence once the app can reach hosted | Agent, Ben | 0.5 d | **Yes** | Counsel review; add GDPR and CCPA specifics |
| L4 | **Subprocessor list** (`/subprocessors`) | Cloudflare (hosting, D1/R2/DO, Email Sending, Turnstile, AI Gateway), Stripe, Autumn, OpenRouter (+ the routed model provider), DataForSEO (orgs using OpenSEO), Loops, GitHub (if the integration is used), Google (if social sign-in), Proton (support mail). Purpose, data, location | Agent | 0.1 d | **Yes** | Add a change-notice mechanism (email or RSS) |
| L5 | **Abuse channel** | `abuse@`, `security@`, `postmaster@` and `support@everyapp.com` on Proton; a Turnstile-protected form at `everyapp.com/abuse` → gateway `POST /api/abuse-reports` → `abuse_reports` table (listed in the H19 ops console), plus a notice email to a verified destination (free on any plan); `/.well-known/security.txt` on `everyapp.com` and the content domain; the "report abuse" link in the D3 interstitial and in every system email footer | Agent builds, Ben runs | 0.5 d code + ops | **Yes** | Add stated response times |
| L6 | **Takedown and abuse runbook** (`docs/runbooks/abuse-and-takedown.md`) | Triage (phishing and malware: act first, H10 takedown within hours; content disputes: human); owner notice template; evidence kept 30 days (security S30); DMCA notice → takedown → counter-notice → restore "not less than 10, nor more than 14, business days" after the counter-notice unless suit is filed (17 U.S.C. § 512(g)(2)(C)); repeat-infringer rule (Cloudflare's §8 makes ours necessary); CSAM: never download, disable, report to NCMEC CyberTipline, preserve 1 year (§ 2258A(h)); law-enforcement requests; appeals; audit rows | Agent, Ben approves | 0.5 d | **Yes** | Add automated scanning (Safe Browsing, password-form heuristics), security S30 GA, 3 d |
| L7 | **DMCA designated agent** | Register or amend Every App, Inc at the Copyright Office ($6): alternate names `everyapp.com`, the content domain, `openseo.so`; renewal reminder at 3 years | Ben | 0.1 d | **Yes** | Renew |
| L8 | **Provider permission** | Written confirmation from OpenRouter that customers' own apps calling models through our metered broker is "incorporating" and not "reselling" (§7 item 4), or a partner agreement; until then, AI for org apps stays behind D3/D8 approval | Ben | email | **Yes**, if the first org deploys custom code that uses AI | Yes |
| L9 | **Data Processing Addendum** | GDPR Art. 28 terms for business customers (processing on instructions, subprocessors, deletion, assistance, SCCs by reference), offered on request | Agent, counsel | 0.5 d | No | **Yes** |
| L10 | **Consumer billing disclosures** | Auto-renewal terms, cancel in the Stripe portal (OpenSEO has it), credit top-up terms on the checkout page | Agent | 0.25 d | No (invited orgs) | **Yes** |
| L11 | **Account settings that make L3 true** | OpenRouter: logging opt-in off, training opt-out on, for the hosted key; AI Gateway: payload logging off (`cf-aig-collect-log-payload: false` from the broker, or `collect_logs: false`); Workers Logs sampling per D10 | Ben (settings) + H20 | 0.1 d | **Yes** | Yes |
| L12 | **Commercial email compliance** | CAN-SPAM: Loops footers carry a physical address and unsubscribe. Transactional mail from Cloudflare carries none, so keep it free of marketing | Ben | 0 | Yes | Yes |

**Tier-0 total** (L1-L8, L11): about 2.5 writing days and about 1 engineering
day, plus Ben's sign-offs. Public sign-up adds L9, L10, counsel review and
the GA scanning items.

**Recommended default for D16:** the agent drafts L1-L6 this week from
OpenSEO's documents and this report. Ben reviews and publishes them before
the first outside org. Counsel reviews them once, before public sign-up.
- **Cost to change later:** low for the pages themselves (they are versioned
  and stamped per user).
- **The expensive part is promises:** retracting "we never store prompts" or
  "an org can export and leave" means notifying every user, and OpenSEO's
  privacy policy commits to 30 days' notice for significant changes. Keep
  first versions precise and modest.

---

## 4. Exact README.md changes

**§2, table row "Email transport"**: replace the row with:

> | Email transport | refactor (small) | `server/email/sendEmail.ts`, `services/InvitationService.ts:40-48`, `auth/config.ts:294-301` | Cloudflare Email Sending (public beta since 2026-04-16; Workers Paid; 3,000/month included, then $0.35/1,000; new accounts start on a conservative daily quota) through the `send_email` binding; Docker self-host uses the REST endpoint with `EMAIL_REST_API_TOKEN`, a Cloudflare API token. Hosted adds escaped templates (the invitation email interpolates the org name raw, and in hosted any stranger names an org), invitation budgets, suppression-aware errors, and a Queue consumer for bounce and complaint events. Sender `noreply@mail.everyapp.com`. Lifecycle and founder sequences stay on Loops: Cloudflare's Email Service terms allow transactional mail only (`raw/r2-email-and-legal.md`). |

**§3, Tier C**: add after C9:

> **C10. Email and legal minimums.** (a) The invitation email puts the org name and inviter email into the subject and HTML unescaped (`InvitationService.ts:40-48`). In hosted, anyone names an org and invites any address, so our sender would deliver their link or phone number. Scammers did exactly this through OpenAI's team invites (BleepingComputer, 2026-06-26) and through Zoom, PayPal and Microsoft notifications, about 133,260 emails (Check Point, 2026-02-05). Complaints count against the account that also sends every verification email (Email Service terms §3). Fix in H9: escape everything, validate org names, verified inviters only, per-org invite budgets, complaints as an abuse signal. 1 d. (b) Hosted has no Terms, AUP, privacy policy, subprocessor list, abuse channel or takedown runbook. `everyapp.com/privacy` covers only the iOS app and says "We do not operate any servers that receive your data" (`landing-page/src/routes/privacy.tsx:36-37`). Cloudflare makes us "solely responsible for the acts of [our] End Users" (Developer Platform terms §3, 2026-09-28), forbids deceptive subdomain names (§6), and can terminate an account over repeated DMCA notices (Self-Serve Agreement §8), so one tenant's infringement or phishing endangers the whole account. Fix: H27 and D16.

**§4, D10**: append to the end of the paragraph:

> Abuse intake: `abuse@everyapp.com`, a Turnstile-protected form at `everyapp.com/abuse` feeding an `abuse_reports` table in the ops console, `/.well-known/security.txt`, a DMCA notice and counter-notice path with a registered designated agent and a repeat-infringer rule, app ids and org keys checked against a deceptive-names list (Cloudflare Developer Platform terms §6), and apparent CSAM reported to NCMEC's CyberTipline as 18 U.S.C. § 2258A requires. Documents and owners: D16.

**§4, new D16** (after D12):

> **D16. Who writes the Terms, AUP, privacy policy and abuse process, and when?**
> Why: Cloudflare makes us solely responsible for our End Users and flows its whole Agreement down to them (Developer Platform terms §3, §10). The broker's privacy promise ("prompts never stored") holds only with specific OpenRouter and AI Gateway settings. OpenRouter forbids "reselling API access to Models" (§7). The current `everyapp.com/privacy` is false for hosted. Options: (a) the agent adapts OpenSEO's Every App, Inc documents, Ben approves, counsel reviews before public sign-up; (b) counsel drafts from scratch now; (c) a policy generator. Default: (a). Before the first outside org: Terms, AUP, hosted privacy policy, subprocessor list, `abuse@` plus form plus `security.txt`, takedown runbook, DMCA agent registered, OpenRouter's written OK for org apps, and acceptance stamped at sign-up (`raw/r2-email-and-legal.md` §3 B, L1-L8, L11). Before public sign-up: counsel review, a DPA, billing disclosures, automated phishing scanning. Cost to change: pages are cheap to revise; retracting a promise (prompt storage, export, deletion windows) needs user notice, so keep first versions precise.

**§4, "Defaults we will take unless told otherwise"**: replace the bullet
"Dub referrals dropped for the prototype; lifecycle emails via the gateway's
email transport; multipart AI routes excluded from hosted v1." with:

> - Dub referrals dropped for the prototype; multipart AI routes excluded from hosted v1.
> - Email: transactional mail (verification, reset, invitations, payment and balance notices, suspension, takedown and deletion notices) through Cloudflare Email Sending from `noreply@mail.everyapp.com`; lifecycle and founder sequences through Loops (OpenSEO spec 0015, ported); human mail (`support@`, `abuse@`, `security@`, `postmaster@`) on Proton at the `everyapp.com` apex; apex DMARC `p=none` for two weeks, then `p=reject`. Tenant apps never get `send_email`. No second transactional provider unless R24 fails.

**§5, H9 row**: append to "Contains":

> one escaped email template module (layout, `escapeHtml` on every value, text part, footer with the abuse link) used by reset, invitation and verification; org-name validation; invitations only from verified users with a per-org daily budget; `E_RECIPIENT_SUPPRESSED`/`E_DAILY_LIMIT_EXCEEDED` mapped to typed errors; `allowedSenderAddresses` on the binding; Terms and Privacy acceptance stamped on `users` (`terms_version`, `terms_accepted_at`) at sign-up and invitation acceptance.

Change H9's size from 5 to 6. In the Self-host column add: "The escaping fix applies to both modes."

**§5, new row H27** (after H26):

> | H27 | **Email events, legal pages, abuse intake** | Ops: onboard `mail.everyapp.com` for Email Sending on the account holding the zone (see R26), Proton on the apex, DMARC, delete the duplicate `_dmarc.everyapp.dev`, file the Email Sending limit increase. Code: Queue event subscription for `message.bounced`/`message.complained` → `users.email_undeliverable_at` and an org abuse signal for complaints on invitations; landing-page `/terms`, `/acceptable-use`, `/privacy` (hosted; the iOS policy moves to `/privacy/ios`), `/subprocessors`, `/abuse` (Turnstile form → `POST /api/abuse-reports` → `abuse_reports` + a notice to a verified destination); `/.well-known/security.txt` on `everyapp.com` and the content domain; `docs/runbooks/abuse-and-takedown.md`; DMCA agent registered. | H9 (stamp), H10 (takedown), D16 | 1.5 code + 2.5 writing | Pages and runbook are hosted-only |

**§5, "Totals"**: add "+1 d (H9) and H27 (4 d)" to the phase 2 core
(about 79 d).

**§5, "The first outside org"** paragraph: add after "the takedown in H10":

> , H27's tier-0 subset (Terms, AUP, hosted privacy policy, subprocessors, `abuse@` and the form, the takedown runbook, the DMCA agent, OpenRouter's written OK if the org's own code uses AI)

**§6, new rows:**

> | R24 | Cloudflare Email Sending's starting daily quota and "Sandbox" on a new account carry sign-up verification mail | Documented only as "conservative" (limits page, 2026-09-25; terms §4) | Onboard `mail.everyapp.com` on the hosted account, send to an unverified Gmail address, read the quota in the dashboard, file the increase | Add the Resend transport behind `sendEmail.ts` (0.5 d; Pro $20/mo for 50k) |
> | R25 | OpenRouter §7 item 4 ("reselling API access to Models") covers metered model access for customers' own apps | Terms 2026-08-31; interpretation open | Ask OpenRouter in writing, describing the broker and markup | Org apps get AI only through catalog-style features, or AI Gateway BYOK/Unified Billing for org apps (D6) |
> | R26 | `app.everyapp.com` (Custom Domain) and the `mail.everyapp.com` sender both need the `everyapp.com` zone in the account that runs them | Custom Domains "on a zone you do not own" refused (2026-09-29); Email Sending onboards "a domain from your Cloudflare account" | `cf zones list` on both accounts; try onboarding from the hosted account | Move the zone and the marketing Worker into the hosted account with D7, or send through REST with a token from the zone's account |

**§7, Appendix**: add rows:

> | `everyapp.com/privacy`: "We do not operate any servers that receive your data" (`landing-page/src/routes/privacy.tsx:36-37`) | false once hosted runs | Scope it to the iOS app at `/privacy/ios`; publish a hosted policy (r2-email-and-legal) |
> | Defaults: "lifecycle emails via the gateway's email transport" (README §4) | qualified | Cloudflare's Email Service terms §1-§2 allow transactional mail only; founder check-ins and product news stay on Loops (r2-email-and-legal) |
> | §2: email transport "as-is" | qualified | Templates interpolate org names unescaped; in hosted those are attacker-controlled (r2-email-and-legal) |
> | D6: "prompts never stored" | conditional | True only with AI Gateway payload logging off and OpenRouter's logging opt-in off; the draft backstop config sets `collect_logs: true` (r2-email-and-legal; ai-gateway §2.1.6) |

---

## 5. New founder decisions

1. **D16 (above): who drafts the legal set, and when.** Default: the agent
   adapts OpenSEO's documents now; Ben approves before the first outside
   org; counsel reviews before public sign-up.
2. **DMCA agent of record and the public address.** The OpenSEO Terms
   publish Benjamin Senescu at 34 Harding Street, Cambridge. Default:
   register or amend Every App, Inc's designation now, listing
   `everyapp.com`, the content domain and `openseo.so`. If that address is
   personal, use a P.O. box or registered-agent address instead. That is
   also cheaper than changing it later, which needs a $6 amendment plus
   edits to the Terms.
3. **Lifecycle mail: reuse OpenSEO's Loops account?** Default: yes. Port
   spec 0015, tag contacts by product, keep transactional mail on
   Cloudflare. The alternative (everything on Cloudflare, no founder
   check-ins or newsletters) conflicts with Cloudflare's terms for anything
   promotional.
4. **Ask OpenRouter before org apps get metered AI?** Default: yes, before
   the first outside org deploys its own code that uses AI. Catalog apps
   proceed regardless.
5. **The `everyapp.com` zone moves to the hosted account** (folds into D7).
   Default: yes, together with the marketing Worker, before H8.

---

## 6. UNVERIFIED items and the live check that settles each

| Item | Live check |
|---|---|
| The starting daily quota and "Sandbox" rules for Email Sending on a new account | Onboard `mail.everyapp.com` on the hosted account; send to a fresh Gmail address; read Email Sending → limits in the dashboard; file the increase form |
| Whether an unrestricted `send_email` binding sends to arbitrary recipients on Workers Paid. The send-bindings page says the unrestricted binding "can send to any verified destination address"; the beta changelog example sends to an arbitrary user | Deploy the gateway on the hosted account and request a password reset for an address that is not a verified destination |
| Where onboarding a subdomain writes `_dmarc` (`_dmarc.mail.everyapp.com` or the apex) | Onboard, then `dig TXT _dmarc.mail.everyapp.com` and `_dmarc.everyapp.com` |
| Whether a binding can send from a domain whose zone is in another account | Try it from the hosted account before the zone moves (R26) |
| Postmark webhook event types and new-account approval; SES bounce feeds; Resend templates | Not needed under the default; read the official docs only if R24 forces a second provider |
| Proton's current SPF recommendation for the apex (`~all` or `-all`) and its DKIM targets for `everyapp.com` | Add the domain in Proton; copy its records |
| Whether Every App, Inc already has a DMCA designation and which names it lists | Search https://www.copyright.gov/dmca-directory/ for "Every App" and "OpenSEO" |
| Whether OpenRouter §7 item 4 covers the broker for org apps | Written answer from OpenRouter (R25) |
| Whether the hosted OpenRouter account has logging off and training opt-out on | Check the OpenRouter privacy and observability settings for the hosted key |
| Whether AI Gateway payload logging is off for the hosted gateway | After H20, inspect a log entry for body fields; confirm the broker sends `cf-aig-collect-log-payload: false` |
| Whether "provider" in § 2258A (defined in § 2258E) covers a hosting platform of this kind | Counsel, during the pre-public-sign-up review |
| Counsel cost and turnaround for the review | Quote from counsel |
| Whether 34 Harding Street is a business address | Ben |
