/**
 * The provider pages of the user docs (landing-page/content/docs/providers),
 * generated so they can't drift from the code: one page per company, with a
 * section for each way to connect it (an API key, people's accounts through
 * an OAuth client, sign-in), from
 *
 *  - the built-in catalog (`CAPABILITIES`): API-key, AI and OAuth client entries;
 *  - the OAuth presets (`oauthPresetIds()`/`oauthPreset()`): providers an
 *    operator adds with `everyapp provider add --oauth <id>`;
 *  - the sign-in providers (`SIGN_IN_PROVIDER_LIST`);
 *
 * and the hand-written steps, categories and app notes of providerGuides.ts.
 * index.mdx and meta.json are generated too; custom.mdx is hand-written.
 * providerPages.test.ts compares them and `pnpm -C packages/cli docs:update`
 * rewrites them, deleting the page of a company that is gone.
 */
import {
  CAPABILITIES,
  CAPABILITY_IDS,
  SIGN_IN_PROVIDER_LIST,
  capabilitySettings,
  isSettableGatewaySetting,
  oauthPreset,
  oauthPresetIds,
  signInCallbackPath,
  type AiProviderCapability,
  type ApiKeyCapability,
  type Capability,
  type OAuthClientCapability,
  type ProviderDetails,
  type SignInProvider,
} from "@every-app/sdk/internal";
import {
  CATEGORIES,
  CATEGORY_OF,
  CATEGORY_OF_TAG,
  COMPANY_OF,
  GUIDES,
  type CompanyGuide,
  type ProviderCategory,
} from "./providerGuides";

/** The repository, as the public reads it (the landing page's sync script links the same). */
const GITHUB = "https://github.com/every-app/every-app";
const SETUP_GUIDES = `${GITHUB}/blob/main/packages/cli/skills/everyapp/setup`;
/** The issue form for asking for a provider or a fuller guide (.github/ISSUE_TEMPLATE/provider-request.yml). */
export const PROVIDER_REQUEST_TEMPLATE = "provider-request.yml";
const requestUrl = (title: string) =>
  `${GITHUB}/issues/new?template=${PROVIDER_REQUEST_TEMPLATE}&title=${encodeURIComponent(title).replace(/\(/g, "%28").replace(/\)/g, "%29")}`;

/** Pages in the folder that are written by hand, never generated or deleted. */
export const HAND_WRITTEN_PROVIDER_PAGES = ["custom.mdx"] as const;

type KeyEntry = readonly [string, ApiKeyCapability | AiProviderCapability];
type ClientEntry = { id: string; client: OAuthClientCapability; preset: boolean };

interface Company {
  slug: string;
  name: string;
  category: ProviderCategory;
  keys: KeyEntry[];
  clients: ClientEntry[];
  signIn?: SignInProvider;
  service?: string;
  guide: CompanyGuide;
}

const companyOf = (id: string) => COMPANY_OF[id] ?? id.replace(/-oauth$/, "");

/** Every company with explicit support, in catalog order (built-ins, then presets, then sign-in). */
export function providerCompanies(): Company[] {
  const companies = new Map<string, Company>();
  const at = (id: string, name: string): Company => {
    const slug = companyOf(id);
    let company = companies.get(slug);
    if (!company) {
      const guide = GUIDES[slug] ?? {};
      company = { slug, name: guide.name ?? name, category: "dev", keys: [], clients: [], guide };
      companies.set(slug, company);
    }
    return company;
  };
  for (const id of CAPABILITY_IDS) {
    const capability = CAPABILITIES[id] as Capability;
    if (capability.mode === "api_key" || capability.mode === "ai") {
      at(id, capability.label).keys.push([id, capability]);
    } else if (capability.mode === "oauth_client") {
      at(id, shortLabel(capability.label)).clients.push({ id, client: capability, preset: false });
    } else if (id === "email") {
      at(id, capability.label).service = id;
    }
  }
  for (const id of oauthPresetIds()) {
    const client = oauthPreset(id);
    if (!client || client.mode !== "oauth_client") continue;
    if (companies.get(companyOf(id))?.clients.some((entry) => entry.id === id)) continue;
    at(id, client.label).clients.push({ id, client, preset: true });
  }
  for (const provider of SIGN_IN_PROVIDER_LIST) {
    at(provider.id, provider.id === "oidc" ? "Single sign-on (OIDC)" : provider.label).signIn = provider;
  }
  for (const company of companies.values()) company.category = categoryOf(company);
  return [...companies.values()];
}

/** "Google (Gmail, Calendar…)" → "Google". */
function shortLabel(label: string): string {
  return label.replace(/\s*\(.*\)$/, "");
}

function categoryOf(company: Company): ProviderCategory {
  const named = CATEGORY_OF[company.slug];
  if (named) return named;
  if (company.keys.some(([, capability]) => capability.mode === "ai")) return "ai";
  const tags = [
    ...company.keys.flatMap(([, capability]) => capability.tags ?? []),
    ...company.clients.flatMap(({ client }) => client.tags ?? []),
  ];
  for (const tag of tags) {
    const category = CATEGORY_OF_TAG[tag];
    if (category) return category;
  }
  if (company.keys.length === 0 && company.clients.length > 0) return "social";
  if (company.keys.length === 0 && company.clients.length === 0 && company.signIn) return "signin";
  return "dev";
}

// ---------------------------------------------------------------------------
// Text

/**
 * Prose for MDX: outside code spans, `<`, `{` and `}` would open JSX, so
 * they are escaped; code spans stay as written.
 */
function prose(text: string): string {
  return text
    .split(/(`+[^`]*`+)/)
    .map((part, index) =>
      index % 2 === 1 ? part : part.replace(/</g, "&lt;").replace(/[{}_*]/g, (character) => `\\${character}`),
    )
    .join("");
}

const code = (text: string) => `\`${text}\``;
const sentence = (text: string) => (/[.!?)]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);
const numbered = (steps: readonly string[]) => steps.map((step, index) => `${index + 1}. ${step}`).join("\n");
const bash = (...lines: string[]) => ["```bash", ...lines, "```"].join("\n");
const hostOf = (url: string) => {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
};
const link = (url: string) => (url.startsWith("https://") ? `[${hostOf(url)}](${url})` : code(url));

function settableOf(capability: Capability): string[] {
  return capabilitySettings(capability).filter((name) => isSettableGatewaySetting(name));
}

function verifiedLine(details: ProviderDetails): string | null {
  if (details.verified === false) {
    return "**Unverified.** Nobody has checked this entry against the provider's own docs yet. If something here is wrong, [tell us](" + requestUrl("Fix provider docs: ") + ").";
  }
  return null;
}

function costLines(details: ProviderDetails): string[] {
  const lines: string[] = [];
  if (details.cost?.note) lines.push(`- **Cost:** ${prose(sentence(details.cost.note))}`);
  else if (details.cost?.usd !== undefined) {
    const unit = { call: "a call", result: "a result", token: "a token" }[details.cost.unit];
    lines.push(`- **Cost:** $${details.cost.usd} ${unit}.`);
  }
  if (details.cost?.responseField) lines.push("- The Gateway reads each call's price from the answer, so it shows in **Manage workspace → Usage**.");
  const rate = details.rate;
  if (rate) {
    const limits = [
      ...(rate.perSecond === undefined ? [] : [`${rate.perSecond} calls a second`]),
      ...(rate.perMinute === undefined ? [] : [`${rate.perMinute} a minute`]),
      ...(rate.perDay === undefined ? [] : [`${rate.perDay} a day`]),
    ];
    const text = [limits.join(", "), rate.note].filter(Boolean).join(". ");
    if (text) lines.push(`- **Rate limits:** ${prose(sentence(text))}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Sections

function keySection(company: Company, [id, capability]: KeyEntry, heading: string): string[] {
  const guide = company.guide;
  const settable = settableOf(capability);
  const isAi = capability.mode === "ai";
  const isProxy = isAi && capability.kind === "proxy";
  const steps = guide.key && company.keys.length === 1 ? guide.key : null;
  const hint = capability.hint ?? capability.secrets?.find((detail) => detail.hint)?.hint;
  const out: string[] = [`## ${heading}`, ""];
  if (capability.description && company.keys.length > 1) out.push(prose(sentence(capability.description)), "");
  const facts = [
    `- **${isProxy ? "Open it here" : "Get your key here"}:** ${link(capability.docs)}`,
    ...(settable.length > 0 && !isProxy ? [`- **Setting${settable.length > 1 ? "s" : ""}:** ${settable.map(code).join(", ")}`] : []),
    ...(capability.api ? [`- **API reference:** ${link(capability.api)}`] : []),
  ];
  out.push(...facts, "");
  const unverified = verifiedLine(capability);
  if (unverified) out.push(unverified, "");

  out.push(isProxy ? "### Steps" : "### Get the key", "");
  if (steps) {
    out.push(numbered(steps), "");
  } else {
    out.push(
      numbered([
        `Sign in to ${prose(capability.label)} and open ${link(capability.docs)}.`,
        "Create an API key (or token) with only the access your apps need.",
        "Copy it. Many providers show a key only once.",
      ]),
      "",
      ...(hint ? [`**What to create:** ${prose(sentence(hint))}`, ""] : []),
      `Steps for this provider are brief. [Open an issue](${requestUrl(`Provider guide: ${capability.label}`)}) to request a full guide.`,
      "",
    );
  }

  if (!isProxy) {
    out.push(
      "### Set it on your Gateway",
      "",
      "From your EveryApp folder:",
      "",
      bash(`everyapp secret set ${settable.join(" ")}`),
      "",
      "It asks for the value at a hidden prompt, and it's live at once, with no deploy. If an app you've installed needs it, `everyapp configure <app>` asks for it along with everything else the app needs.",
      "",
    );
    if (isAi && capability.chat) {
      out.push(
        `To make it the model provider apps get when they ask for the default:`,
        "",
        bash(`everyapp ai default ${id}`),
        "",
      );
    }
    out.push("### Use it in an app", "", "List it in the app's `everyapp.config.ts`:", "");
    if (isAi) {
      out.push("```ts", `providers: ["${id}"],`, "```", "", `The app calls \`/api/ai/${id}/…\` with \`createGatewayFetch()\`. More in [AI](/docs/agent/ai).`, "");
    } else {
      const write = capability.access.includes("write") ? ' (or `"write"` where it changes things)' : "";
      out.push(
        "```ts",
        "capabilities: {",
        `  ${/^[a-z][a-z0-9]*$/.test(id) ? id : JSON.stringify(id)}: { access: "read", why: "What the app does with it." },`,
        "},",
        "```",
        "",
        `\`access\` is \`"read"\`${write}. The app calls the provider's own URLs with \`integrationFetch()\`, and the Gateway adds the key. More in [API providers](/docs/agent/providers).`,
        "",
      );
    }
  }

  out.push("### Check it worked", "");
  const checks = isProxy
    ? ["`everyapp secret list` lists `AI_GATEWAY_ID`, and the AI Gateway's dashboard shows the calls your apps make."]
    : isAi
    ? [`\`everyapp ai list\` shows ${code(id)} with its key set, and \`everyapp ai show\` says which provider apps get by default.`]
    : [`\`everyapp provider show ${id}\` shows the key as set and which apps use it.`];
  if (!isProxy) checks.push("`everyapp status` shows apps that were waiting for it as ready.");
  if (capability.smoke) {
    const host = capability.smoke.host ?? (capability.mode === "api_key" ? capability.hosts[0] : new URL(capability.origin).host);
    if (host) {
      checks.push(
        `To test the key itself, ${code(`${capability.smoke.method} https://${host}${capability.smoke.path}`)} with it should answer ${capability.smoke.expect.join(" or ")}${capability.smoke.free ? "; the call is free" : "; the call is charged"}.`,
      );
    }
  }
  out.push(checks.map((check) => `- ${check}`).join("\n"), "");

  const cost = costLines(capability);
  if (cost.length > 0) out.push("### Cost and limits", "", ...cost, "");
  return out;
}

function connectSection(company: Company, { id, client, preset }: ClientEntry, heading: string): string[] {
  const guide = company.guide;
  const gatewayFlow = client.flow !== undefined;
  const settings = [client.secrets.clientId, ...(client.secrets.clientSecret ? [client.secrets.clientSecret] : [])];
  const sets = Object.entries(client.scopePolicy?.sets ?? {});
  const console = link(client.console);
  const out: string[] = [`## ${heading}`, ""];
  out.push(
    gatewayFlow
      ? `Each person connects their own ${prose(shortLabel(client.label))} account once, in the Gateway, and every app that asks for it uses that connection. Apps never see the tokens. [How connecting works](/docs/connect-oauth)`
      : `The Gateway holds the OAuth client; the app runs the sign-in itself and keeps people's tokens.`,
    "",
  );
  if (client.description && company.clients.length > 1) out.push(prose(sentence(client.description)), "");
  out.push(
    `- **Make the OAuth app here:** ${console}`,
    `- **Settings:** ${settings.map(code).join(", ")}`,
    ...(preset ? [`- **Added with:** ${code(`everyapp provider add --oauth ${id}`)}`] : ["- **Built in:** nothing to add, only the client to set"]),
    "",
  );

  out.push("### Redirect URI", "");
  const appCallbacks = `An app that runs the sign-in itself lists its own callbacks under \`redirectPaths\` in its manifest entry; register those too, as \`https://<app>.<your gateway><path>\`. \`everyapp provider show ${id}\` prints every one.`;
  if (gatewayFlow) {
    out.push("Register this at the provider:", "", "```text", `https://<your gateway>/connect/${id}/callback`, "```", "");
    out.push(`\`<your gateway>\` is your Gateway's address, like \`apps.example.com\`.`, "", appCallbacks, "");
  } else {
    out.push(appCallbacks, "");
  }

  out.push("### Make the OAuth app", "");
  if (guide.connect && company.clients.length === 1) {
    out.push(numbered(guide.connect), "");
  } else {
    if (client.hint) out.push(prose(sentence(client.hint)), "");
    out.push(
      numbered([
        `Open ${console} and create an OAuth app (sometimes called a client or an integration).`,
        "Add the redirect URI above.",
        ...(sets.length > 0 ? ["Allow the scopes behind the sets your apps use (the table below), and no others."] : []),
        "Copy the client ID and the client secret. The secret is often shown once.",
      ]),
      "",
      `Steps for this provider are brief. [Open an issue](${requestUrl(`Provider guide: ${shortLabel(client.label)}`)}) to request a full guide.`,
      "",
    );
  }
  out.push("### Set it on your Gateway", "", "From your EveryApp folder:", "");
  if (preset) {
    out.push(bash(`everyapp provider add --oauth ${id}`, `everyapp secret set ${settings.join(" ")}`), "");
  } else {
    out.push(bash(`everyapp secret set ${settings.join(" ")}`), "");
  }
  out.push(
    "Each value goes in at a hidden prompt. Or, as an owner or admin, paste the client in **Manage workspace → Providers → Add OAuth provider**.",
    "",
  );

  if (sets.length > 0) {
    out.push(
      "### Scope sets",
      "",
      "Apps ask for named sets, never raw scopes, and the Gateway holds each app to the sets it declared.",
      "",
      "| Set | Allows | Provider scopes |",
      "| --- | --- | --- |",
      ...sets.map(
        ([name, set]) =>
          `| ${code(name)} | ${prose(set.label).replace(/\|/g, "\\|")} | ${[...set.scopes, ...(set.userScopes ?? [])].map(code).join(", ")} |`,
      ),
      "",
    );
  }

  // The example asks for the first set beyond `identity`, with the access that set needs.
  const [example] = sets.filter(([name]) => name !== "identity").concat(sets);
  const key = /^[a-z][a-z0-9]*$/.test(id) ? id : JSON.stringify(id);
  out.push(
    "### Use it in an app",
    "",
    "```ts",
    "capabilities: {",
    `  ${key}: { access: "${example?.[1].access ?? "read"}",${example ? ` scopes: [${JSON.stringify(example[0])}],` : ""} why: "What the app does with it." },`,
    "},",
    "```",
    "",
  );

  out.push("### Check it worked", "");
  out.push(
    [
      `- \`everyapp provider show ${id}\` shows the client as set, and the redirect URI.`,
      ...(gatewayFlow
        ? [
            `- Open the account menu → **Connected accounts** → **Connect ${prose(shortLabel(client.label))}**. You land back in the Gateway, connected.`,
            "- `everyapp provider connections` lists who has connected.",
          ]
        : []),
    ].join("\n"),
    "",
  );
  return out;
}

function signInSection(provider: SignInProvider, heading: string): string[] {
  const out: string[] = [`## ${heading}`, ""];
  out.push(
    `${code(`Continue with ${provider.id === "oidc" ? "SSO" : provider.label}`)} on your Gateway's sign-in page, for people you've invited. It's another way into the same account. [Sign-in](/docs/sign-in)`,
    "",
  );
  const console = provider.console.startsWith("https://") ? link(provider.console) : prose(provider.console);
  out.push("### Make the OAuth app", "");
  out.push(
    numbered([
      `Open ${console} and create ${/^[aeiou]/i.test(provider.appNoun) ? "an" : "a"} ${prose(provider.appNoun)}.`,
      `Add the redirect URL ${code(`https://<your gateway>${signInCallbackPath(provider.id)}`)}. It asks only for ${provider.scopes.map(code).join(", ")}: who someone is, nothing an app could act with.`,
      `Copy what the Gateway needs:\n${provider.settings
        .filter((setting) => setting.required)
        .map((setting) => `   - ${code(setting.name)}: ${prose(sentence(setting.what))}`)
        .join("\n")}`,
    ]),
    "",
  );
  if (provider.notes.length > 0) out.push(provider.notes.map((note) => `- ${prose(note)}`).join("\n"), "");
  const optional = provider.settings.filter((setting) => !setting.required);
  if (optional.length > 0) {
    out.push(`Optional: ${optional.map((setting) => `${code(setting.name)}, ${prose(setting.what.replace(/\.$/, ""))}`).join("; ")}.`, "");
  }
  out.push(
    "### Turn it on",
    "",
    bash(`everyapp signin add ${provider.id}`),
    "",
    "It asks for each value, the secret at a hidden prompt, and the button is on the sign-in page as soon as it's done.",
    "",
    "### Check it worked",
    "",
    `\`everyapp signin show ${provider.id}\` shows each setting as set and the redirect URL. Then sign out and select the button.`,
    "",
  );
  return out;
}

// ---------------------------------------------------------------------------
// Pages


/** The pages are generated: a YAML comment says so (an MDX comment would reach the served Markdown). */
function frontmatter(title: string, description: string): string {
  return [
    "---",
    "# Generated by packages/cli/src/docs/providerPages.ts from the provider catalog; edit providerGuides.ts or the catalog, then pnpm -C packages/cli docs:update.",
    `title: ${JSON.stringify(title)}`, `description: ${JSON.stringify(description)}`, "---"].join("\n");
}

/** What the company's page is about, in one line, for the index and the description. */
function summaryOf(company: Company): string {
  const described = [
    ...company.keys.map(([, capability]) => capability.description),
    ...company.clients.map(({ client }) => client.description),
  ].find(Boolean);
  if (described) return sentence(described);
  const client = company.clients[0]?.client;
  if (client) {
    const inside = client.label.match(/\((.*)\)$/)?.[1];
    return inside ? sentence(`People connect their own accounts: ${inside}`) : `People connect their own ${shortLabel(client.label)} accounts.`;
  }
  if (company.service === "email") return "Mail from the Gateway and every app, through Cloudflare Email Sending or Resend.";
  if (company.signIn) return `"Continue with ${company.signIn.id === "oidc" ? "SSO" : company.signIn.label}" on your Gateway's sign-in page.`;
  return `${company.name}.`;
}

/** The ways a company connects, in page order, as the index lists them. */
function waysOf(company: Company): string[] {
  return [
    ...(company.keys.length > 0 ? [company.keys.some(([, c]) => c.mode === "ai" && c.kind !== "proxy") ? "model key" : company.keys.some(([, c]) => c.mode === "ai") ? "switch" : "API key"] : []),
    ...(company.service ? ["Gateway service"] : []),
    ...(company.clients.length > 0 ? ["connect accounts"] : []),
    ...(company.signIn ? ["sign in"] : []),
  ];
}

function setupGuideOf(company: Company): string[] {
  const guides = new Set<string>();
  for (const [, capability] of company.keys) if (capability.setup) guides.add(capability.setup);
  for (const { client } of company.clients) if (client.setup) guides.add(client.setup);
  if (company.service) {
    const service = CAPABILITIES[company.service as keyof typeof CAPABILITIES] as Capability;
    if (service.setup) guides.add(service.setup);
  }
  if (company.signIn) guides.add(company.signIn.setup);
  return [...guides];
}

function companyPage(company: Company): string {
  const guide = company.guide;
  const out: string[] = [frontmatter(company.name, summaryOf(company)), ""];
  out.push(prose(guide.blurb ?? summaryOf(company)), "");
  if (guide.usedBy && guide.usedBy.length > 0) {
    out.push(`**Used by:** ${guide.usedBy.join("; ")}.`, "");
  }
  const ways = waysOf(company);
  if (ways.length > 1) out.push(`**Ways to connect:** ${ways.join(", ")}.`, "");

  for (const entry of company.keys) {
    const [, capability] = entry;
    const proxy = capability.mode === "ai" && capability.kind === "proxy";
    const base = proxy ? "Turn it on" : "API key";
    out.push(...keySection(company, entry, company.keys.length > 1 ? `${base}: ${capability.label}` : base));
  }
  for (const entry of company.clients) {
    const base = entry.client.flow !== undefined ? "Connect accounts" : "OAuth client for apps";
    out.push(...connectSection(company, entry, company.clients.length > 1 ? `${base}: ${shortLabel(entry.client.label)}` : base));
  }
  for (const extra of guide.extra ?? []) out.push(`## ${extra.title}`, "", extra.body, "");
  if (company.signIn) {
    out.push(...signInSection(company.signIn, company.signIn.id === "oidc" ? "Sign in with your SSO" : `Sign in with ${company.signIn.label}`));
  }

  const guides = setupGuideOf(company);
  out.push("## More help", "");
  const help = [
    ...guides.map((path) => `- Your coding agent has the full step-by-step guide in the everyapp skill: [${code(path)}](${SETUP_GUIDES}/${path.replace(/^setup\//, "")}). Ask it to set ${prose(company.name)} up.`),
    "- [All providers](/docs/providers), and [adding one that isn't listed](/docs/providers/custom).",
    `- Something wrong or missing? [Open an issue](${requestUrl(`Provider guide: ${company.name}`)}).`,
  ];
  out.push(help.join("\n"), "");
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "")}\n`;
}

function providersIndexPage(companies: readonly Company[]): string {
  const out: string[] = [
    frontmatter(
      "Providers",
      "Every service EveryApp has built-in support for: model providers, search and data APIs, email, people's Google, Microsoft and GitHub accounts, and sign-in. Where to get each key and the command that sets it.",
    ),
    "",
    "A provider is a service your apps use: a model provider, a search API, people's Google accounts. Each page below says where to get the key, the steps, and the `everyapp` command that sets it.",
    "",
    "**Supported** means three things:",
    "",
    "- **Your Gateway holds the key.** You set it once, from your EveryApp folder, and every app that needs it uses it.",
    "- **Apps declare what they need** in `everyapp.config.ts`, and `everyapp configure <app>` asks for exactly that.",
    "- **Keys never reach app code.** The Gateway adds the key to each call, and only to that provider's own addresses.",
    "",
    "Not listed? You can [add any provider yourself](/docs/providers/custom), or ask us for a page.",
    "",
  ];
  for (const category of CATEGORIES) {
    const members = companies.filter((company) => company.category === category.id);
    if (members.length === 0) continue;
    out.push(`## ${category.title}`, "");
    out.push(
      members
        .map((company) => `- **[${prose(company.name)}](/docs/providers/${company.slug})**: ${prose(summaryOf(company))} _${waysOf(company).join(", ")}_`)
        .join("\n"),
      "",
    );
  }
  out.push(
    "## Not listed",
    "",
    "- [Add a custom provider](/docs/providers/custom): any API with a key, or any OAuth provider, in one JSON file.",
    "- [Remote MCP servers](/docs/agent/mcp#mcp-apps): add an MCP server by its URL and your agents get its tools.",
    `- [Request a provider](${requestUrl("Provider request: ")}): open an issue and we'll write its page.`,
    "",
  );
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "")}\n`;
}

function providersMeta(companies: readonly Company[]): string {
  const pages: string[] = ["index", "custom"];
  for (const category of CATEGORIES) {
    const members = companies.filter((company) => company.category === category.id);
    if (members.length === 0) continue;
    pages.push(`---${category.title}---`, ...members.map((company) => company.slug));
  }
  return `${JSON.stringify({ title: "Providers", pages }, null, 2)}\n`;
}

/** Every generated file of the folder, by file name. */
export function providerPages(): Map<string, string> {
  const companies = providerCompanies();
  const files = new Map<string, string>();
  for (const company of companies) {
    if (company.slug === "index" || company.slug === "custom") throw new Error(`a provider can't take the page name ${company.slug}`);
    files.set(`${company.slug}.mdx`, companyPage(company));
  }
  files.set("index.mdx", providersIndexPage(companies));
  files.set("meta.json", providersMeta(companies));
  return files;
}

/** The agent page's table: every company page, its ids, its settings and its command. */
export function providerPagesTable(): string {
  const rows = providerCompanies().map((company) => {
    const ids = [
      ...company.keys.map(([id]) => id),
      ...company.clients.map(({ id, preset }) => (preset ? `${id} (preset)` : id)),
      ...(company.service ? [company.service] : []),
      ...(company.signIn ? [`${company.signIn.id} (sign-in)`] : []),
    ];
    const settings = [
      ...company.keys.flatMap(([, capability]) => settableOf(capability)),
      ...company.clients.flatMap(({ client }) => [client.secrets.clientId, ...(client.secrets.clientSecret ? [client.secrets.clientSecret] : [])]),
    ];
    const commands = [
      ...(company.keys.length > 0 && settings.length > 0 ? [`secret set ${settableOf(company.keys[0]![1]).join(" ")}`] : []),
      ...company.clients.filter((entry) => entry.preset).map(({ id }) => `provider add --oauth ${id}`),
      ...(company.signIn ? [`signin add ${company.signIn.id}`] : []),
    ];
    const docs = [...company.keys.map(([, c]) => c.docs), ...company.clients.map(({ client }) => client.console)][0] ?? company.signIn?.console ?? "";
    return `| [${company.slug}](/docs/providers/${company.slug}) | ${ids.map(code).join(", ")} | ${settings.map(code).join(", ")} | ${commands.map(code).join(", ")} | ${docs.replace(/\|/g, "\\|")} |`;
  });
  return [
    "<!-- prettier-ignore-start -->",
    "<!-- provider-pages:begin (generated by packages/cli/src/docs/providerPages.ts; pnpm -C packages/cli docs:update) -->",
    "",
    "| Page | Ids | Settings | Command (`everyapp …`) | Where the key or client comes from |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "<!-- provider-pages:end -->",
    "<!-- prettier-ignore-end -->",
  ].join("\n");
}
