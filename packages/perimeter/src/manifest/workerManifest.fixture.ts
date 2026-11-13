/** A manifest the size of the one Cloudflare refused (7.1 kB): 34 settings and four features, each with its reasons. */
export function largeManifest() {
  return {
    id: "sink",
    name: "Sink",
    description: "Shorten, share and manage links.",
    resources: { d1: ["DB"] },
    public: [{ path: "/s/:slug", methods: ["GET", "HEAD"] }],
    providers: [{ id: "workers-ai", why: "Suggests slugs." }],
    capabilities: {
      members: { access: "read", why: "Shows who made each link." },
    },
    ai: { models: ["@cf/meta/llama"], chat: { why: "Suggests slugs." } },
    secrets: [
      { name: "SITE_TOKEN", why: "Signs API calls.", how: "Any long value." },
    ],
    settings: Array.from({ length: 34 }, (_, index) => ({
      name: `NUXT_SETTING_${index}`,
      why: `Choose how the app handles option number ${index}, which changes what visitors get when they follow a link.`,
      type: "text",
      default: "301",
    })),
    features: Object.fromEntries(
      ["analytics", "previews", "why", "imports"].map((id) => [
        id,
        {
          name: id,
          why: `Turns on ${id}, with everything the app needs for it once the steps below are done.`,
          steps: [
            "Open the Cloudflare dashboard and make an API token with Account Analytics read.",
            "Paste it with `everyapp configure sink`, then open the app again.",
          ],
          settings: [{ name: `FEATURE_${id.toUpperCase()}`, how: "A URL." }],
        },
      ]),
    ),
  } as const;
}
