/**
 * The product's name and colors, in one place. Every user-visible mention of
 * the product in the Gateway reads this: the wordmark, the browser title and
 * description, the consent page, the email subjects, the OAuth and MCP error
 * copy, the PWA install dialog and the event emails. A deployment that
 * carries its own brand changes these values and nothing else.
 *
 * public/site.webmanifest repeats the name and colors, because it is a
 * static file.
 *
 * Identifiers are not brand: the `everyapp` CLI, the `x-everyapp-*` headers,
 * the `everyapp_*` tools, Worker and resource names and the MCP
 * `serverInfo.name` keep their names whatever this says.
 *
 * Kept free of imports, so the server and the client can both load it.
 */
export const BRAND = {
  /** The product's name: the wordmark, the page title and every sentence. */
  name: "EveryApp",
  /** For tight spots: the home-screen label of the installed app. */
  shortName: "EveryApp",
  /** The page's meta description. */
  description:
    "Make every app open source. No subscriptions or paywalls. Own your data. Share with the world.",
  /** The browser and installed-app chrome color, per color scheme. */
  themeColor: { light: "#f0f0f0", dark: "#121212" },
} as const;
