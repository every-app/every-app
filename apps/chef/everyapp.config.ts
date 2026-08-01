/**
 * Every App v2 manifest for Chef.
 *
 * Chef stays private by default and may call OpenAI through the gateway's
 * binding-backed provider proxy.
 */
export default {
  id: "chef",
  name: "Chef",
  description: "AI-powered recipes and cooking assistant",
  main: "@tanstack/react-start/server-entry",
  resources: {
    d1: ["DB"],
    kv: ["KV"],
  },
  providers: ["openai"],
  public: [],
  devPort: 3001,
} as const;
