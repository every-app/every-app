// The setup commands onboarding shows to someone without a Gateway, from
// landing-page/content/docs/gateway.mdx. The window shows them; main copies them by id
// ("clipboard:copySetup"), so the window never puts free text on the clipboard. No Electron import.

/** The person's setup guide, linked from onboarding. */
export const GATEWAY_GUIDE_URL = "https://everyapp.com/docs/gateway";

/** Scribe's backend repository (the OpenScribe project). */
export const OPENSCRIBE_REPOSITORY = "https://github.com/every-app/open-scribe";

export const SETUP_COMMANDS = {
  cli: "npm install -g everyapp",
  gateway: "everyapp setup",
  scribe: `everyapp install ${OPENSCRIBE_REPOSITORY}`,
} as const;

export type SetupCommandId = keyof typeof SETUP_COMMANDS;

export function isSetupCommandId(value: unknown): value is SetupCommandId {
  return typeof value === "string" && Object.hasOwn(SETUP_COMMANDS, value);
}
