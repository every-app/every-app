/**
 * The hand-written half of the provider pages (landing-page/content/docs/providers):
 * which company each entry belongs to, the category it is listed under, which
 * apps use it, and numbered steps for getting the credential where the
 * catalog's one-line hint isn't enough. Everything else on a page (ids,
 * settings, hosts, commands, scope sets, costs, the docs URL) comes from the
 * catalog, the OAuth presets and the sign-in providers through
 * providerPages.ts, so a provider added there gets a page with generic steps
 * the next time `pnpm -C packages/cli docs:update` runs.
 *
 * Steps are short and plain: what to open, what to click, what to copy.
 * They summarize the everyapp skill's setup guides (packages/cli/skills/everyapp/setup)
 * where one exists; each page links that guide for the full version.
 */

export type ProviderCategory =
  | "ai"
  | "speech"
  | "search"
  | "email"
  | "payments"
  | "work"
  | "dev"
  | "social"
  | "signin";

/** The index's sections, in order. */
export const CATEGORIES: ReadonlyArray<{ id: ProviderCategory; title: string }> = [
  { id: "ai", title: "AI models" },
  { id: "speech", title: "Speech, images and embeddings" },
  { id: "search", title: "Search, scraping and data" },
  { id: "email", title: "Email and messaging" },
  { id: "payments", title: "Payments and commerce" },
  { id: "work", title: "CRM, docs and work tools" },
  { id: "dev", title: "Developer tools and infrastructure" },
  { id: "social", title: "Social and content" },
  { id: "signin", title: "Sign-in only" },
];

/**
 * An entry's company page, where it isn't the entry's id with `-oauth`
 * dropped: `github-oauth` lands on `github` by that rule, Google Workspace
 * here.
 */
export const COMPANY_OF: Readonly<Record<string, string>> = {
  "google-workspace": "google",
  "microsoft-365": "microsoft",
  "turso-db": "turso",
};

/** The category of a company whose tags don't say it plainly. */
export const CATEGORY_OF: Readonly<Record<string, ProviderCategory>> = {
  email: "email",
  google: "work",
  microsoft: "work",
  slack: "email",
  discord: "social",
  "workers-ai": "ai",
  "ai-gateway": "ai",
  openrouter: "ai",
  openai: "ai",
  dataforseo: "search",
  context: "search",
  github: "dev",
  gitlab: "dev",
  cloudflare: "dev",
  posthog: "dev",
  mixpanel: "dev",
  segment: "dev",
  linear: "work",
  notion: "work",
  atlassian: "work",
  zoom: "work",
  dropbox: "work",
  airtable: "work",
  hubspot: "work",
  attio: "work",
  pipedrive: "work",
  intercom: "email",
  crisp: "email",
  twilio: "email",
  postmark: "email",
  sendgrid: "email",
  spotify: "social",
  x: "social",
  mapbox: "search",
  openweather: "search",
  newsapi: "search",
  replicate: "speech",
  huggingface: "speech",
  voyage: "speech",
  deepgram: "speech",
  elevenlabs: "speech",
  assemblyai: "speech",
  apple: "signin",
  oidc: "signin",
};

/** A tag of an entry, to the category it suggests, for a company CATEGORY_OF doesn't name. */
export const CATEGORY_OF_TAG: Readonly<Record<string, ProviderCategory>> = {
  llm: "ai",
  speech: "speech",
  embeddings: "speech",
  images: "speech",
  search: "search",
  scrape: "search",
  serp: "search",
  email: "email",
  sms: "email",
  messaging: "email",
  payments: "payments",
  billing: "payments",
  ecommerce: "payments",
  finance: "payments",
  crm: "work",
  docs: "work",
  issues: "work",
  database: "dev",
  hosting: "dev",
  analytics: "dev",
  code: "dev",
};

export interface CompanyGuide {
  /** The page's title, when the entries' labels aren't it. */
  name?: string;
  /** One or two sentences under the title, when the entries' descriptions aren't enough. */
  blurb?: string;
  /** The apps that use it, as Markdown: "[OpenSEO](/docs/apps/openseo) for keyword data". */
  usedBy?: readonly string[];
  /** Steps to get an API key (or an AI provider's key). */
  key?: readonly string[];
  /** Steps to make the OAuth client for "Connect accounts". */
  connect?: readonly string[];
  /** Extra sections, `## Title` then Markdown, after the generated ones. */
  extra?: ReadonlyArray<{ title: string; body: string }>;
}

const OPENSEO = "[OpenSEO](/docs/apps/openseo)";
const CRM = "[OpenCRM](/docs/apps/crm)";
const INBOX = "[OpenMail](/docs/apps/openmail)";
const ANALYTICS = "[OpenAnalytics](/docs/apps/analytics)";
const REPOLENS = "[RepoLens](/docs/apps/repolens)";

/** Hand-written guides, by company page. A company without one gets generic steps. */
export const GUIDES: Readonly<Record<string, CompanyGuide>> = {
  openrouter: {
    blurb:
      "One key for hundreds of models from every major lab. It's the key to set first: OpenSEO, OpenCRM and OpenMail all run on it.",
    usedBy: [`${OPENSEO} for its SEO agent`, `${CRM} for its research agent and web research`, `${INBOX} for its email agent`],
    key: [
      "Sign in or sign up at [openrouter.ai](https://openrouter.ai/sign-in), with Google, GitHub or an email address.",
      "Add credits at [Settings → Credits](https://openrouter.ai/settings/credits): $10 is a good start, $5 the minimum. Without credits every call fails.",
      "Open [Settings → Keys](https://openrouter.ai/settings/keys) and select **Create Key**. Name it after your Gateway, and give it a credit limit you're happy to lose, reset monthly.",
      "Copy the key. OpenRouter shows it once, so keep the tab open until it's set.",
    ],
  },
  openai: {
    key: [
      "Sign in or sign up at [platform.openai.com](https://platform.openai.com).",
      "Add a card and prepaid credits under [Settings → Billing](https://platform.openai.com/settings/organization/billing/overview) ($5 minimum). Turn auto-reload off unless you want it.",
      "Open [API keys](https://platform.openai.com/api-keys) and select **Create new secret key**. Owned by **You**, any project, permissions **All**. Your first key asks for a phone number.",
      "Copy the key. It's shown once.",
    ],
  },
  anthropic: {
    key: [
      "Sign in to the [Claude Console](https://platform.claude.com).",
      "Add a card and buy credits under **Settings → Billing**.",
      "Open [Settings → API keys](https://platform.claude.com/settings/keys) and create a key in the workspace you want the Gateway's calls billed to.",
      "Copy the key. It's shown once.",
    ],
  },
  gemini: {
    name: "Google Gemini",
    key: [
      "Sign in to [Google AI Studio](https://aistudio.google.com) with a Google account.",
      "Open [Get API key](https://aistudio.google.com/apikey) and select **Create API key**, in a new or an existing Google Cloud project.",
      "Restrict the key to the Gemini API (the key's settings in the Cloud console, **API restrictions**).",
      "Copy the key. Free tier keys have low limits; turn on billing in the project for real use.",
    ],
  },
  mistral: {
    key: [
      "Sign in to the [Mistral console](https://console.mistral.ai).",
      "Pick a plan under **Billing**: the free plan needs no card but has low limits.",
      "Open **API Keys**, select **Create new key**, and give it an expiry date you'll remember.",
      "Copy the key. It's shown once.",
    ],
  },
  groq: {
    key: [
      "Sign in to the [Groq console](https://console.groq.com).",
      "Open [API Keys](https://console.groq.com/keys) and select **Create API Key**.",
      "Copy the key. It's shown once.",
    ],
  },
  cohere: {
    key: [
      "Sign in to the [Cohere dashboard](https://dashboard.cohere.com).",
      "Open [API keys](https://dashboard.cohere.com/api-keys). A trial key is free but limited to 1,000 calls a month; create a production key for real use (it needs a card).",
      "Copy the key.",
    ],
  },
  "workers-ai": {
    blurb:
      "Cloudflare's own models, run in the same Cloudflare account as your Gateway. There's no separate sign-up and nothing to prepay: usage is billed to that account.",
    usedBy: [`${INBOX} can use it as its model provider`],
    key: [
      "In the Cloudflare dashboard, open the [Workers AI page](https://dash.cloudflare.com/?to=/:account/ai/workers-ai) of your Gateway's account.",
      "Select **Use REST API**, then **Create a Workers AI API Token**. The form comes prefilled with Workers AI permissions on this account; check the account and select **Create API Token**.",
      "Copy the token. It's shown once.",
      "`CLOUDFLARE_ACCOUNT_ID` is your Gateway's own account, which `everyapp setup` already set. You only set the token.",
    ],
  },
  "ai-gateway": {
    name: "Cloudflare AI Gateway",
    blurb:
      "Not a model provider of its own: once it's on, model calls to providers it supports pass through Cloudflare AI Gateway, in your account, for its logs, caching and analytics. Your keys stay on the Gateway.",
    key: [
      "Run `pnpm everyapp ai gateway on`. It finds or creates an AI Gateway named `everyapp` in your account and turns it on. Nothing to copy.",
      "Optional: to require a token, open the AI Gateway in the dashboard, **Settings → Authenticated Gateway**, turn it on and create a token. Then set it with `pnpm everyapp secret set AI_GATEWAY_API_KEY`.",
    ],
  },
  dataforseo: {
    blurb: "Search data for SEO: keyword volumes, live Google results, domain rankings and backlinks. You pay per call, from a prepaid balance.",
    usedBy: [`${OPENSEO} for all of its research (required)`],
    key: [
      "Sign up at [app.dataforseo.com](https://app.dataforseo.com/register) and confirm your email. New accounts get $1 of credit.",
      "Open [API Access](https://app.dataforseo.com/api-access). It shows your **API login** and **API password** (after 24 hours, select **Send by e-mail** to get the password again). It's not your dashboard password.",
      "Leave the **IP Access** list empty: the Gateway calls from Cloudflare's addresses, which change.",
      "Optional, before real use: **Add Funds** ($50 minimum) and a daily limit under [API Settings](https://app.dataforseo.com/api-settings).",
      "The value to set is the login and password joined by a colon: `login:password`.",
    ],
  },
  context: {
    name: "Context.dev",
    blurb: "Renders and reads web pages, JavaScript included: brand data, LinkedIn profiles and clean page text. Free up to 1,000 rendered pages a month.",
    usedBy: [`${CRM} for company research (required)`, `${OPENSEO} for rendered site audits (optional)`],
    key: [
      "Sign up or sign in at [context.dev](https://www.context.dev/signup), with an email, Google or GitHub.",
      "Open [API keys](https://context.dev/dashboard/api-keys) and create a key. **Full access** is fine.",
      "Copy the key. It may be shown once.",
    ],
  },
  stripe: {
    key: [
      "Sign in to the [Stripe dashboard](https://dashboard.stripe.com). To try things first, switch to a sandbox (test mode).",
      "Open [Developers → API keys](https://dashboard.stripe.com/apikeys) and select **Create restricted key**.",
      "Give it a name, and set **Read** only on what the app needs (for example Customers, Subscriptions and Charges). Leave everything else at **None**.",
      "Select **Create key** and copy it (`rk_live_…`, or `rk_test_…` in a sandbox).",
    ],
  },
  github: {
    blurb: "Repositories, issues, pull requests and releases. Use a token when an app works on your own repositories; let people connect their own accounts when it works on theirs.",
    usedBy: [`${REPOLENS} reads traffic, stars and downloads with a token`],
    key: [
      "Open [Settings → Developer settings → Fine-grained tokens → Generate new token](https://github.com/settings/personal-access-tokens/new).",
      "Name it after your Gateway and pick an expiry. Under **Resource owner**, pick the account or organization whose repositories the app reads.",
      "Under **Repository access**, choose only the repositories the app needs.",
      "Under **Permissions**, give the least the app needs (for example **Contents: Read** and **Metadata: Read**).",
      "Select **Generate token** and copy it. It's shown once.",
    ],
    connect: [
      "Open [Settings → Developer settings → OAuth Apps](https://github.com/settings/developers) and select **New OAuth App**. Make an OAuth App, not a GitHub App.",
      "Fill in a name and your Gateway's address as the homepage. For **Authorization callback URL**, paste the redirect URI above.",
      "Select **Register application**, then **Generate a new client secret**.",
      "Copy the **Client ID** and the client secret. The secret is shown once.",
    ],
  },
  linear: {
    key: [
      "In Linear, open [Settings → Account → Security & access](https://linear.app/settings/account/security).",
      "Under **Personal API keys**, select **New API key**. Limit it to the permissions and teams the app needs.",
      "Copy the key. It's shown once.",
    ],
    connect: [
      "Open [Settings → API → OAuth applications](https://linear.app/settings/api/applications) in your Linear workspace and create a new application.",
      "Add the redirect URI above as a callback URL.",
      "Save, then copy the **Client ID** and **Client secret**.",
    ],
  },
  posthog: {
    key: [
      "Sign in to PostHog in the region your project lives in (US or EU).",
      "Open [Settings → Personal API keys](https://us.posthog.com/settings/user-api-keys) and select **Create personal API key**.",
      "Pick the organization or project it can reach, and only the scopes the app needs (for example **Insight: Read**).",
      "Copy the key (`phx_…`). It's shown once. It's not the project token that starts with `phc_`.",
    ],
  },
  postmark: {
    key: [
      "Sign in to [Postmark](https://account.postmarkapp.com) and open the server the app sends from.",
      "Open the server's **API Tokens** tab.",
      "Copy a **Server API token**. Never the Account API token.",
    ],
  },
  sendgrid: {
    key: [
      "Sign in to [SendGrid](https://app.sendgrid.com) and open [Settings → API Keys](https://app.sendgrid.com/settings/api_keys).",
      "Select **Create API Key**, choose **Restricted Access**, and give it **Mail Send** only.",
      "Copy the key. It's shown once.",
    ],
  },
  cloudflare: {
    blurb:
      "Cloudflare's API for an app that manages zones, DNS, Workers or storage. Your Gateway already runs on Cloudflare; this is a separate token an app uses on purpose.",
    key: [
      "Open [My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens) and select **Create Token**.",
      "Start from a template, or a custom token, with only the permissions and zones the app needs. Never use the Global API Key.",
      "A token on your Gateway's own account can change the Gateway. Keep it narrow, or use another account.",
      "Select **Continue to summary**, **Create Token**, and copy it. It's shown once.",
    ],
  },
  google: {
    name: "Google",
    blurb:
      "One OAuth client in your own Google Cloud project lets each person connect their own Google account: Gmail, Calendar, Search Console and Analytics, read only, whichever the apps you run ask for. The same page covers Sign in with Google, which is a separate client.",
    usedBy: [
      `${OPENSEO} for Search Console and Google Analytics (the \`identity\`, \`search-console.read\` and \`analytics.read\` sets)`,
      `${CRM} for Gmail and Google Calendar (the \`gmail.read\` and \`calendar.read\` sets)`,
    ],
    connect: [
      "Signed in to Google, [create a Cloud project](https://console.cloud.google.com/projectcreate) (for example `EveryApp`). With Google Workspace, put it in your organization.",
      "Enable the APIs behind the sets your apps use (the table below): for OpenSEO, the [Search Console API](https://console.cloud.google.com/apis/library/searchconsole.googleapis.com), the [Analytics Admin API](https://console.cloud.google.com/apis/library/analyticsadmin.googleapis.com) and the [Analytics Data API](https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com); for OpenCRM, the Gmail API and the Google Calendar API.",
      "Set up the [consent screen](https://console.cloud.google.com/auth/overview): an app name people will see, a support email, and the audience: **Internal** (your Workspace only, no review) or **External**.",
      "On [Data Access](https://console.cloud.google.com/auth/scopes), add the scopes of those sets and no others: `webmasters.readonly` and `analytics.readonly` for OpenSEO, `gmail.readonly` and `calendar.readonly` for OpenCRM.",
      "[Create a client](https://console.cloud.google.com/auth/clients): type **Web application**, and under **Authorized redirect URIs** add the redirect URI above. Copy the **Client ID** and **Client secret**, or select **Download JSON**.",
      "**External** only: while the app is in Testing, add each person under **Audience → Test users**. Their access lasts 7 days at a time until you publish the app and Google verifies it.",
    ],
    extra: [
      {
        title: "Search Console",
        body: [
          "For an app that lists the `search-console.read` set, OpenSEO among them:",
          "",
          "1. Enable the [Google Search Console API](https://console.cloud.google.com/apis/library/searchconsole.googleapis.com) in the client's project.",
          "2. Add `https://www.googleapis.com/auth/webmasters.readonly` on the consent screen's [Data Access](https://console.cloud.google.com/auth/scopes) page.",
          "3. Each person connects their own Google account, one that can see the site in Search Console.",
        ].join("\n"),
      },
      {
        title: "Google Analytics",
        body: [
          "For an app that lists the `analytics.read` set, OpenSEO among them:",
          "",
          "1. Enable the [Google Analytics Admin API](https://console.cloud.google.com/apis/library/analyticsadmin.googleapis.com) and the [Google Analytics Data API](https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com) in the client's project.",
          "2. Add `https://www.googleapis.com/auth/analytics.readonly` on the consent screen's [Data Access](https://console.cloud.google.com/auth/scopes) page.",
          "3. Each person connects a Google account with access to the GA4 property.",
        ].join("\n"),
      },
    ],
  },
  microsoft: {
    name: "Microsoft",
    blurb:
      "One app registration in Microsoft Entra lets each person connect their own Outlook mailbox and calendar, read only, from a work, school or personal account. The same page covers Sign in with Microsoft, which is a separate registration.",
    usedBy: [`${CRM} for Outlook mail (the \`mail.read\` set)`],
    connect: [
      "Sign in to [Microsoft Entra → App registrations](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade) with an account that administers your tenant, and select **New registration**.",
      "Name it (people see the name when they consent). For **Supported account types**, choose any Entra ID tenant plus personal Microsoft accounts, never single tenant.",
      "Under **Redirect URI**, platform **Web**, paste the redirect URI above, and select **Register**. Copy the **Application (client) ID**.",
      "Under **API permissions → Add a permission → Microsoft Graph → Delegated**, add `User.Read`, `Mail.Read` and `offline_access` (and `Calendars.Read` if an app asks for `calendar.read`).",
      "Under **Certificates & secrets → New client secret**, add one (24 months at most) and copy its **Value** right away. Note the expiry date.",
    ],
  },
  slack: {
    blurb: "A Slack app in your workspace whose client the Gateway holds, so apps can post to approved channels and match people by email.",
    usedBy: [`${CRM} for team agents that post to Slack (optional)`],
    connect: [
      "Open [api.slack.com/apps](https://api.slack.com/apps) and select **Create New App**. **From a manifest** is quickest: your coding agent can write one from the app's scopes.",
      "Pick the workspace. Under **OAuth & Permissions**, add the redirect URI above as a redirect URL, and the bot scopes the apps you run need.",
      "Under **Basic Information → App Credentials**, copy the **Client ID** and **Client Secret**.",
    ],
  },
  email: {
    name: "Email sending",
    blurb:
      "The Gateway sends its own mail (invitations, password resets) and every app's, through one provider for the whole Gateway: Cloudflare Email Sending (the default) or Resend. It's optional: without it, an invitation shows a link to share instead.",
    usedBy: [`${INBOX} to send replies (required)`, `${ANALYTICS} for reports and alerts (optional)`],
    extra: [
      {
        title: "Cloudflare Email Sending",
        body: [
          "The default. Your domain must be on Cloudflare DNS in the Gateway's account, on Workers Paid. There's no key: the Gateway sends through its own `EMAIL` binding.",
          "",
          "1. In the dashboard, open [Email Service → Email Sending](https://dash.cloudflare.com/?to=/:account/email-service/sending) and select **Onboard Domain**.",
          "2. Pick your domain (or a subdomain like `mail.example.com`), review the DNS records it adds, and confirm.",
          "3. Wait until the domain is listed under Email Sending, usually 5 to 15 minutes.",
          "4. Set the sender, below.",
        ].join("\n"),
      },
      {
        title: "Resend",
        body: [
          "When you already use [Resend](https://resend.com) or want its dashboard.",
          "",
          "1. Open [Domains](https://resend.com/domains), select **Add Domain**, and add the domain you'll send from. **Sign in to Cloudflare** adds the DNS records for you.",
          "2. Wait for the domain to show **Verified**.",
          "3. Open [API Keys](https://resend.com/api-keys), select **Create API Key** with **Sending access**, and copy it (`re_…`). It's shown once.",
          "4. Set it, then the sender, below:",
          "",
          "```bash",
          "pnpm everyapp secret set RESEND_API_KEY",
          "```",
        ].join("\n"),
      },
      {
        title: "Set the sender",
        body: [
          "Either provider needs the address mail comes from and the name people see. Neither is a secret.",
          "",
          "```bash",
          "pnpm everyapp secret set EMAIL_FROM",
          "pnpm everyapp secret set EMAIL_FROM_NAME",
          "```",
          "",
          "For example `noreply@example.com` and your company's name. Or run `pnpm everyapp configure openmail`, which asks for both. When both providers are set up, `EMAIL_PROVIDER` (`cloudflare` or `resend`) picks one.",
          "",
          "An app that sends as addresses of its own, like OpenMail, also needs them allowed: `pnpm everyapp email set --sender '*@example.com'`.",
        ].join("\n"),
      },
      {
        title: "Check it worked",
        body: [
          "`pnpm everyapp email show` prints the provider and the sender. Then invite someone from **Manage workspace → People**: the invitation should arrive by email.",
          "",
          "Apps ask for it in `everyapp.config.ts` with `capabilities: { email: { access: \"write\", why: \"…\" } }` and send with `sendEmail()`. More in [Email](/docs/agent/email).",
          "",
          "**Postmark and SendGrid** are separate: an app that calls their APIs itself uses [Postmark](/docs/providers/postmark) or [SendGrid](/docs/providers/sendgrid).",
        ].join("\n"),
      },
    ],
  },
};
