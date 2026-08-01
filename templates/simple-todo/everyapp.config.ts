export default {
  id: "simple-todo-template",
  name: "Simple Todo",
  description: "A simple todo list backed by D1 and KV.",
  main: "src/entry.worker.ts",
  resources: {
    d1: ["DB"],
    kv: ["KV"],
  },
  public: [],
} as const;
