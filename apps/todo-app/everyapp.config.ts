/**
 * Every App v2 manifest — the single source of truth for the todo app's
 * identity, resources, and public surface.
 *
 * cloudflare.config.ts builds the Worker from it, and the CLI validates it
 * and snapshots it into the gateway registry at deploy time.
 *
 * Reference manifest for the migration described in docs/TESTING.md.
 */
export default {
  id: "todo",
  name: "Todos",
  description: "Minimal todo list with real-time sync across devices.",
  resources: {
    d1: ["DB"],
    kv: ["KV"],
    // The UserSyncDO Durable Object backs WebSocket sync; reachable only through
    // the gateway, which injects the verified identity the DO handler reads.
    durableObjects: [{ name: "USER_SYNC", className: "UserSyncDO" }],
  },
  // Default-private: every route requires an authenticated session. The app
  // declares no public routes. (A marketing/health route would go here.)
  public: [],
} as const;
