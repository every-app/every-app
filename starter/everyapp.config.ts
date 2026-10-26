import { defineEveryApp } from "@every-app/sdk";

// defineEveryApp types the manifest; the Worker reads it back as
// env.EVERYAPP_MANIFEST (src/serverFunctions/home.ts).
export default defineEveryApp({
  id: "simple-todo-template",
  name: "Simple Todo",
  description: "A todo list that shows who you are and what it was allowed.",
  resources: {
    d1: ["DB"],
  },
  // Every route needs a member the Gateway signed in. A route something else
  // must reach (a provider's webhook, an OAuth callback) is listed here:
  // public: [{ path: "/webhooks/github", methods: ["POST"] }]
  // What the Gateway does for the app with keys it holds. A call for anything not listed is refused.
  capabilities: {
    members: { access: "read", why: "Shows who can open this app." },
  },
});
