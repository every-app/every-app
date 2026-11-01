import { describe, it, expect } from "vitest";
import { parseHost } from "./host";

describe("parseHost", () => {
  it("splits first label as app, remainder as base host", () => {
    expect(parseHost("todo.example.com")).toEqual({
      appLabel: "todo",
      baseHost: "example.com",
      host: "todo.example.com",
    });
  });

  it("preserves ports and lowercases", () => {
    expect(parseHost("Todo.localhost:8787")).toEqual({
      appLabel: "todo",
      baseHost: "localhost:8787",
      host: "todo.localhost:8787",
    });
  });

  it("handles portless per-worktree hosts", () => {
    expect(parseHost("todo.fix-ui.everyapp.localhost")).toEqual({
      appLabel: "todo",
      baseHost: "fix-ui.everyapp.localhost",
      host: "todo.fix-ui.everyapp.localhost",
    });
  });

  it("treats a bare host as the base (launcher), no app label", () => {
    expect(parseHost("localhost:8787")).toEqual({
      appLabel: "",
      baseHost: "localhost:8787",
      host: "localhost:8787",
    });
  });

  it("returns null for empty/missing host", () => {
    expect(parseHost(null)).toBeNull();
    expect(parseHost("")).toBeNull();
  });
});
