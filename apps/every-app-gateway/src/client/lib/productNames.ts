/**
 * How well-known products write their own names, by the id an app or a
 * provider is usually given, for an MCP app nobody named: `everyapp mcp
 * add stripe` leaves the app called "stripe". The spellings are the
 * catalog's (`CATALOG_ENTRIES` in the SDK), which is too large to load in
 * the browser for a dozen names. An id that isn't here keeps its own name.
 */
const PRODUCT_NAMES: ReadonlyMap<string, string> = new Map([
  ["airtable", "Airtable"],
  ["anthropic", "Anthropic"],
  ["atlassian", "Atlassian"],
  ["cloudflare", "Cloudflare"],
  ["deepgram", "Deepgram"],
  ["dropbox", "Dropbox"],
  ["elevenlabs", "ElevenLabs"],
  ["github", "GitHub"],
  ["gitlab", "GitLab"],
  ["hubspot", "HubSpot"],
  ["intercom", "Intercom"],
  ["linear", "Linear"],
  ["mixpanel", "Mixpanel"],
  ["neon", "Neon"],
  ["notion", "Notion"],
  ["openai", "OpenAI"],
  ["planetscale", "PlanetScale"],
  ["posthog", "PostHog"],
  ["shopify", "Shopify"],
  ["slack", "Slack"],
  ["stripe", "Stripe"],
  ["supabase", "Supabase"],
  ["vercel", "Vercel"],
  ["zoom", "Zoom"],
]);

/** Ids a product also goes by: PlanetScale's own tool is `pscale`. */
const ALIASES: ReadonlyMap<string, string> = new Map([
  ["pscale", "planetscale"],
]);

/**
 * The product an app id names, as the key its name and brand mark are
 * listed under: lower case, without the `-mcp` an MCP app's id often ends
 * in ("elevenlabs-mcp" is ElevenLabs).
 */
export function productKey(id: string): string {
  const key = id.toLowerCase().replace(/(-mcp)+$/, "");
  return ALIASES.get(key) ?? key;
}

/** The product's own spelling of its name, or null for an id that isn't a known product. */
export function productName(id: string): string | null {
  return PRODUCT_NAMES.get(productKey(id)) ?? null;
}
