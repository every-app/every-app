export default {
  id: "simple-todo-template",
  name: "Simple Todo",
  description: "A todo list that shows who you are and what it was allowed.",
  resources: {
    d1: ["DB"],
  },
  // Reachable without signing in. Everything else needs a member the Gateway signed in.
  public: [{ path: "/health" }],
  // What the Gateway does for the app with keys it holds. A call for anything not listed is refused.
  capabilities: {
    members: { access: "read", why: "Shows who can open this app." },
  },
} as const;
