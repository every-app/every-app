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
  resources: {
    d1: ["DB"],
    kv: ["KV"],
  },
  providers: ["openai"],
  public: [],
} as const;
