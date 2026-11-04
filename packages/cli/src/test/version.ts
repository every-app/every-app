import { cliVersion } from "@/lib/version";

/**
 * `text` with this everyapp's version (`everyapp 0.3.0-rc.13` in a deploy
 * message) as `everyapp <version>`, so a snapshot doesn't change with each
 * release.
 */
export function withoutCliVersion(text: string): string {
  return text.replaceAll(`everyapp ${cliVersion}`, "everyapp <version>");
}
