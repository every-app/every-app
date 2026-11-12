/**
 * The provider pages of the user docs (landing-page/content/docs/providers),
 * generated so they can't drift from the code: one page per company, with a
 * section for each way to connect it (an API key, people's accounts through
 * an OAuth client, sign-in), from
 *
 *  - the built-in catalog (`CAPABILITIES`): API-key and AI entries;
 *  - the OAuth presets (`oauthPresetIds()`/`oauthPreset()`): the OAuth
 *    providers, each registered when an app that lists it is deployed or an
 *    operator adds it (`everyapp provider add <id>`);
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
  oauthSetupGuide,
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
  EXAMPLE_SCOPES,
  GUIDES,
  type CompanyGuide,
  type ProviderCategory,
} from "./providerGuides";

/** The repository, as the public reads it (the landing page's sync script links the same). */
const GITHUB = "https://github.com/every-app/every-app";
/** The issue form for asking for a provider or a fuller guide (.github/ISSUE_TEMPLATE/provider-request.yml). */
export const PROVIDER_REQUEST_TEMPLATE = "provider-request.yml";
const requestUrl = (title: string) =>
  `${GITHUB}/issues/new?template=${PROVIDER_REQUEST_TEMPLATE}&title=${encodeURIComponent(title).replace(/\(/g, "%28").replace(/\)/g, "%29")}`;

/** Pages in the folder that are written by hand, never generated or deleted. */
export const HAND_WRITTEN_PROVIDER_PAGES = ["custom.mdx"] as const;

type KeyEntry = readonly [string, ApiKeyCapability | AiProviderCapability];
type ClientEntry = { id: string; client: OAuthClientCapability };

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
    } else if (id === "email") {
      at(id, capability.label).service = id;
    }
  }
  for (const id of oauthPresetIds()) {
    const client = oauthPreset(id);
    if (!client || client.mode !== "oauth_client") continue;
    at(id, client.label).clients.push({ id, client });
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

function verifiedLine(details: ProviderDetails, name: string): string | null {
  if (details.verified === false) {
    return `**Unverified:** nobody has checked this against ${prose(name)}'s own docs yet. [Tell us](${requestUrl("Fix provider docs: ")}) if something is wrong.`;
  }
  return null;
}

function costLines(details: ProviderDetails): string[] {
  const lines: string[] = [];
  if (details.cost?.note) lines.push(`**Cost:** ${prose(sentence(details.cost.note))}`);
  else if (details.cost?.usd !== undefined) {
    const unit = { call: "a call", result: "a result", token: "a token" }[details.cost.unit];
    lines.push(`**Cost:** $${details.cost.usd} ${unit}.`);
  }
  const rate = details.rate;
  if (rate) {
    const limits = [
      ...(rate.perSecond === undefined ? [] : [`${rate.perSecond} calls a second`]),
      ...(rate.perMinute === undefined ? [] : [`${rate.perMinute} a minute`]),
      ...(rate.perDay === undefined ? [] : [`${rate.perDay} a day`]),
    ];
    const text = [limits.join(", "), rate.note].filter(Boolean).join(". ");
    if (text) lines.push(`**Rate limits:** ${prose(sentence(text))}`);
  }
  return lines;
}

/**
 * The part of a catalog hint a person acts on: its first sentence, without
 * how the Gateway sends the key ("…; the Gateway sends it as a bearer token").
 */
function whatToCreate(hint: string): string {
  const first = hint.split(/(?<=[.!?])\s+(?=[A-Z])/)[0] ?? hint;
  const kept = first.split(/;\s*the Gateway\b|,\s*sent (?:as|in)\b|;\s*sent (?:as|in)\b/)[0]!.trim().replace(/[;,]$/, "");
  return /[.!?]$/.test(kept) ? kept : `${kept}.`;
}

const capabilityKey = (id: string) => (/^[a-z][a-z0-9]*$/.test(id) ? id : JSON.stringify(id));

// ---------------------------------------------------------------------------
// Sections

function keySection(company: Company, [id, capability]: KeyEntry, heading: string): string[] {
  const guide = company.guide;
  const isAi = capability.mode === "ai";
  const isProxy = isAi && capability.kind === "proxy";
  const steps = guide.key && company.keys.length === 1 ? guide.key : null;
  const hint = capability.hint ?? capability.secrets?.find((detail) => detail.hint)?.hint;
  const out: string[] = [`## ${heading}`, ""];
  if (capability.description && company.keys.length > 1 && (guide.blurb || sentence(capability.description) !== summaryOf(company))) {
    out.push(prose(sentence(capability.description)), "");
  }
  const unverified = verifiedLine(capability, company.name);
  if (unverified) out.push(unverified, "");

  if (steps) {
    out.push(numbered(steps), "");
  } else {
    out.push(
      numbered([
        `Open ${link(capability.docs)} and create an API key with only the access your apps need.`,
        "Copy it. It may be shown only once.",
      ]),
      "",
      ...(hint ? [`**What to create:** ${prose(whatToCreate(hint))}`, ""] : []),
    );
  }

  if (!isProxy) {
    out.push("Add it to your Gateway. It asks for the key:", "", bash(`everyapp provider add ${id}`), "");
    if (isAi && capability.chat) {
      out.push("To make it the model provider apps get by default:", "", bash(`everyapp ai default ${id}`), "");
    }
    out.push("### Use it in an app", "", "In the app's `everyapp.config.ts`:", "");
    if (isAi) {
      out.push("```ts", `providers: ["${id}"],`, "```", "", `The app calls \`/api/ai/${id}/…\` with \`createGatewayFetch()\`. More in [AI](/docs/agent/ai).`, "");
    } else {
      const write = capability.access.includes("write") ? ' Use `"write"` if the app changes things.' : "";
      const api = capability.api ? `[API](${capability.api})` : "API";
      out.push(
        "```ts",
        "capabilities: {",
        `  ${capabilityKey(id)}: { access: "read", why: "What the app does with it." },`,
        "},",
        "```",
        "",
        `The app calls ${prose(shortLabel(capability.label))}'s ${api} with \`integrationFetch()\`, and the Gateway adds the key.${write} More in [API providers](/docs/agent/providers).`,
        "",
      );
    }
  }

  const check = isProxy
    ? "`everyapp secret list` lists `AI_GATEWAY_ID`, and the AI Gateway dashboard shows your apps' calls."
    : isAi
      ? `\`everyapp ai show\` lists ${code(id)} with its key set.`
      : `\`everyapp provider show ${id}\` shows the key as set.`;
  out.push(`**Check it worked:** ${check}`, "");
  out.push(...costLines(capability).flatMap((line) => [line, ""]));
  return out;
}

function connectSection(company: Company, { id, client }: ClientEntry, heading: string): string[] {
  const guide = company.guide;
  const console = link(client.console);
  const name = prose(shortLabel(client.label));
  const out: string[] = [`## ${heading}`, ""];
  out.push(
    `Each person connects their own ${name} account once, then allows each app that uses it. Apps never see the tokens. [How connecting works](/docs/connect-oauth)`,
    "",
  );
  if (client.description && company.clients.length > 1) out.push(prose(sentence(client.description)), "");
  out.push("The redirect URI to register, with your Gateway's address (like `apps.example.com`):", "", "```text", `https://<your gateway>/connect/${id}/callback`, "```", "");

  if (guide.connect && company.clients.length === 1) {
    out.push(numbered(guide.connect), "");
  } else {
    if (client.hint) out.push(prose(sentence(client.hint)), "");
    out.push(
      numbered([
        `Open ${console} and create an OAuth app (also called a client or an integration).`,
        "Add the redirect URI above.",
        "Copy the client ID and client secret. The secret is often shown only once.",
      ]),
      "",
    );
  }
  out.push(
    "Add it to your Gateway. It asks for the client ID and secret:",
    "",
    bash(`everyapp provider add ${id}`),
    "",
    "Or add it in **Manage workspace → Providers**.",
    "",
  );

  // The provider's own scope strings, as the app writes them.
  const example = EXAMPLE_SCOPES[id];
  const scopes = example ? example.map((scope) => JSON.stringify(scope)).join(", ") : `/* ${name}'s scopes */`;
  const { flow } = client;
  const reference = client.reference ? `[${name}'s scopes](${client.reference})` : `${name}'s scopes`;
  out.push(
    "### Use it in an app",
    "",
    "List the provider's own scopes in the app's `everyapp.config.ts`:",
    "",
    "```ts",
    "capabilities: {",
    `  ${capabilityKey(id)}: { scopes: [${scopes}], why: "What the app does with it." },`,
    "},",
    "```",
    "",
    `Use ${reference}${flow.scopePrefix ? `, short as above or in full (${code(`${flow.scopePrefix}…`)})` : ""}. ${
      flow.identityScopes.length > 0 ? `The Gateway adds ${flow.identityScopes.map(code).join(", ")} itself; don't list them. ` : ""
    }The app calls ${name}'s API with \`integrationFetch()\`, and the Gateway adds the person's token. A token with more scopes than your apps list is refused.`,
    "",
  );

  out.push(
    `**Check it worked:** \`everyapp provider show ${id}\` shows the client as set. Then open an app that lists it and select its **Connect** button.`,
    "",
  );
  return out;
}

function signInSection(provider: SignInProvider, heading: string): string[] {
  const out: string[] = [`## ${heading}`, ""];
  out.push(
    `Adds **Continue with ${provider.id === "oidc" ? "SSO" : prose(provider.label)}** to your Gateway's sign-in page, for people you've invited. [Sign-in](/docs/sign-in)`,
    "",
  );
  const console = provider.console.startsWith("https://") ? link(provider.console) : prose(provider.console);
  out.push(
    numbered([
      `Open ${console} and create ${/^[aeiou]/i.test(provider.appNoun) ? "an" : "a"} ${prose(provider.appNoun)}.`,
      `Add the redirect URL ${code(`https://<your gateway>${signInCallbackPath(provider.id)}`)}.`,
      `Copy:\n${provider.settings
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
    "Turn it on. It asks for each value:",
    "",
    bash(`everyapp signin add ${provider.id}`),
    "",
    `**Check it worked:** \`everyapp signin show ${provider.id}\` shows each setting as set. Then sign out and select the button.`,
    "",
  );
  return out;
}

// ---------------------------------------------------------------------------
// Pages


/** The pages are generated: a YAML comment says so (an MDX comment would reach the served Markdown). */
function frontmatter(title: string, description: string, meta?: { title: string; description: string }): string {
  return [
    "---",
    "# Generated by packages/cli/src/docs/providerPages.ts from the provider catalog; edit providerGuides.ts or the catalog, then pnpm -C packages/cli docs:update.",
    `title: ${JSON.stringify(title)}`, `description: ${JSON.stringify(description)}`,
    ...(meta ? [`metaTitle: ${JSON.stringify(meta.title)}`, `metaDescription: ${JSON.stringify(meta.description)}`] : []),
    "---"].join("\n");
}

/** What search results show for a company's page: the company's name alone says nothing about what the page does for you. */
function searchMetaOf(company: Company): { title: string; description: string } {
  const summary = summaryOf(company);
  const name = company.name.replace(/ \(.*\)$/, "");
  const api = /API$/.test(name) ? name : `${name} API`;
  // A title, then the sentence after the summary: the longer one when it fits in 160 characters.
  const [title, ...tails] =
    company.service || company.keys.some(([, capability]) => capability.mode === "ai" && capability.kind === "proxy")
      ? [`${name} for your apps`, "Set it up once on your EveryApp Gateway."]
    : company.keys.length > 0 ? [`${api} in your apps`, "Get a key and add it to your EveryApp Gateway in one command.", "Add the key to your EveryApp Gateway."]
    : company.clients.length > 0 ? [`Connect ${name} accounts to your apps`, "Register the OAuth app once on your EveryApp Gateway; each person connects their own account.", "Each person connects their own account."]
    : company.signIn?.id === "oidc" ? ["Single sign-on (OIDC) for your Gateway", "Turn it on for your EveryApp Gateway in one command."]
    : [`Sign in with ${name}`, "Turn it on for your EveryApp Gateway in one command."];
  const description = tails.map((tail) => `${summary} ${tail}`).find((text) => text.length <= 160) ?? summary;
  return { title, description };
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

function setupGuideOf(company: Company): string[] {
  const guides = new Set<string>();
  for (const [, capability] of company.keys) if (capability.setup) guides.add(capability.setup);
  for (const { id } of company.clients) {
    const guide = oauthSetupGuide(id);
    if (guide) guides.add(guide);
  }
  if (company.service) {
    const service = CAPABILITIES[company.service as keyof typeof CAPABILITIES] as Capability;
    if (service.mode !== "oauth_client" && service.setup) guides.add(service.setup);
  }
  if (company.signIn) guides.add(company.signIn.setup);
  return [...guides];
}

function companyPage(company: Company): string {
  const guide = company.guide;
  const out: string[] = [frontmatter(company.name, summaryOf(company), searchMetaOf(company)), ""];
  out.push(prose(guide.blurb ?? summaryOf(company)), "");
  if (guide.usedBy && guide.usedBy.length > 0) {
    out.push(`**Used by:** ${guide.usedBy.join("; ")}.`, "");
  }

  for (const entry of company.keys) {
    const [, capability] = entry;
    const proxy = capability.mode === "ai" && capability.kind === "proxy";
    const base = proxy ? "Turn it on" : "API key";
    out.push(...keySection(company, entry, company.keys.length > 1 ? `${base}: ${capability.label}` : base));
  }
  for (const entry of company.clients) {
    const base = "Connect accounts";
    out.push(...connectSection(company, entry, company.clients.length > 1 ? `${base}: ${shortLabel(entry.client.label)}` : base));
  }
  for (const extra of guide.extra ?? []) out.push(`## ${extra.title}`, "", extra.body, "");
  if (company.signIn) {
    out.push(...signInSection(company.signIn, company.signIn.id === "oidc" ? "Sign in with your SSO" : `Sign in with ${company.signIn.label}`));
  }

  const guides = setupGuideOf(company);
  if (guides.length > 0) {
    out.push(
      "## More help",
      "",
      `Ask your coding agent to set ${prose(company.name)} up: the agent docs have the full guide (${guides.map((path) => `[${code(path.replace(/\.md$/, ""))}](/docs/agent/${path.replace(/\.md$/, "")})`).join(", ")}).`,
      "",
    );
  }
  out.push(`Something wrong or missing? [Open an issue](${requestUrl(`Provider guide: ${company.name}`)}).`, "");
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "")}\n`;
}

function providersIndexPage(companies: readonly Company[]): string {
  const out: string[] = [
    frontmatter("Providers", "The services your apps can use, where to get each key, and the command that adds it."),
    "",
    "A provider is a service your apps use: a model, a search API, people's Google accounts. Your Gateway holds the key, adds it to each call, and never hands it to app code.",
    "",
    "Add one with its id. It asks for the key:",
    "",
    bash("everyapp provider add openrouter"),
    "",
    "Installing an app? The install asks for every key it needs. Not listed below? [Add any API yourself](/docs/providers/custom).",
    "",
  ];
  for (const category of CATEGORIES) {
    const members = companies.filter((company) => company.category === category.id);
    if (members.length === 0) continue;
    out.push(`## ${category.title}`, "");
    out.push(members.map((company) => `- **[${prose(company.name)}](/docs/providers/${company.slug})**: ${prose(summaryOf(company))}`).join("\n"), "");
  }
  out.push(
    "## Not listed",
    "",
    "- [Add a custom provider](/docs/providers/custom): any API with a key, or any OAuth provider.",
    "- [Remote MCP servers](/docs/agent/mcp#mcp-apps): add an MCP server by its URL.",
    `- [Request a provider](${requestUrl("Provider request: ")}).`,
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
