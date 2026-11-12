import type { IconType } from "react-icons";
import { FaMicrosoft, FaSlack } from "react-icons/fa6";
import { RiOpenaiFill } from "react-icons/ri";
import {
  SiAirtable,
  SiAnthropic,
  SiAtlassian,
  SiBrave,
  SiCloudflare,
  SiDeepgram,
  SiDropbox,
  SiElevenlabs,
  SiGithub,
  SiGitlab,
  SiGoogle,
  SiGooglegemini,
  SiHubspot,
  SiHuggingface,
  SiIntercom,
  SiLemonsqueezy,
  SiLinear,
  SiMapbox,
  SiMistralai,
  SiMixpanel,
  SiNeon,
  SiNotion,
  SiOpenrouter,
  SiPaddle,
  SiPerplexity,
  SiPosthog,
  SiReplicate,
  SiShopify,
  SiSpotify,
  SiStripe,
  SiSupabase,
  SiTurso,
  SiVercel,
  SiZoom,
} from "react-icons/si";

/**
 * Each provider's brand mark, by its id: the OAuth presets
 * (`oauthPresets.ts` in the SDK) and the catalog's providers (its
 * `CATALOG_ENTRIES`) that have one. Simple Icons dropped Microsoft's,
 * Slack's and OpenAI's marks, so those come from Font Awesome and Remix
 * Icon. A provider without a mark has no entry.
 */
const MARKS: ReadonlyMap<string, IconType> = new Map([
  // The OAuth presets.
  ["google-workspace", SiGoogle],
  ["microsoft-365", FaMicrosoft],
  ["slack", FaSlack],
  ["github-oauth", SiGithub],
  ["notion-oauth", SiNotion],
  ["linear-oauth", SiLinear],
  ["gitlab-oauth", SiGitlab],
  ["atlassian", SiAtlassian],
  ["hubspot-oauth", SiHubspot],
  ["zoom", SiZoom],
  ["dropbox", SiDropbox],
  ["spotify", SiSpotify],
  // The catalog: AI.
  ["openai", RiOpenaiFill],
  ["openrouter", SiOpenrouter],
  ["anthropic", SiAnthropic],
  ["gemini", SiGooglegemini],
  ["mistral", SiMistralai],
  ["perplexity", SiPerplexity],
  ["replicate", SiReplicate],
  ["huggingface", SiHuggingface],
  ["workers-ai", SiCloudflare],
  ["ai-gateway", SiCloudflare],
  ["deepgram", SiDeepgram],
  ["elevenlabs", SiElevenlabs],
  // The catalog: everything else.
  ["stripe", SiStripe],
  ["lemonsqueezy", SiLemonsqueezy],
  ["paddle", SiPaddle],
  ["shopify", SiShopify],
  ["hubspot", SiHubspot],
  ["airtable", SiAirtable],
  ["notion", SiNotion],
  ["intercom", SiIntercom],
  ["linear", SiLinear],
  ["github", SiGithub],
  ["gitlab", SiGitlab],
  ["vercel", SiVercel],
  ["cloudflare", SiCloudflare],
  ["posthog", SiPosthog],
  ["mixpanel", SiMixpanel],
  ["supabase", SiSupabase],
  ["turso", SiTurso],
  ["turso-db", SiTurso],
  ["neon", SiNeon],
  ["mapbox", SiMapbox],
  ["brave-search", SiBrave],
]);

/** A preset's brand mark alone, or nothing for a provider without one. */
export function ProviderMark({
  id,
  className,
}: {
  id: string;
  className?: string;
}) {
  const Mark = MARKS.get(id);
  return Mark ? <Mark aria-hidden className={className} /> : null;
}

/**
 * A provider's tile, the size of an app's (AppIcon): its brand mark when it
 * is one of the presets, else the first letter of its name.
 */
export function ProviderIcon({
  provider,
}: {
  provider: { id: string; name: string };
}) {
  const Mark = MARKS.get(provider.id);
  return (
    <span
      aria-hidden
      className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-border bg-card text-lg font-medium"
    >
      {Mark ? (
        <Mark className="size-6" />
      ) : (
        (Array.from(provider.name.trim())[0]?.toUpperCase() ?? "?")
      )}
    </span>
  );
}
