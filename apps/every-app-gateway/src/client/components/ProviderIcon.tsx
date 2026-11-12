import type { IconType } from "react-icons";
import { FaMicrosoft, FaSlack } from "react-icons/fa6";
import {
  SiAtlassian,
  SiDropbox,
  SiGithub,
  SiGitlab,
  SiGoogle,
  SiHubspot,
  SiLinear,
  SiNotion,
  SiSpotify,
  SiZoom,
} from "react-icons/si";

/**
 * The brand mark of each OAuth preset (`oauthPresets.ts` in the SDK), by
 * the preset's id. Simple Icons dropped Microsoft's and Slack's marks, so
 * those two come from Font Awesome.
 */
const MARKS: ReadonlyMap<string, IconType> = new Map([
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
]);

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
