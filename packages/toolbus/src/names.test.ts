import { describe, expect, it } from "vitest";
import {
  exposedToolName,
  namespacedToolName,
  resolveToolName,
  splitNamespacedToolName,
} from "./names";
import { appView, gatewayView, todoApp } from "./test-fixtures";

describe("tool names", () => {
  it("prefixes with the app id and splits on the first underscore", () => {
    expect(namespacedToolName("todo-list", "create_todo")).toBe(
      "todo-list_create_todo",
    );
    expect(splitNamespacedToolName("todo-list_create_todo")).toEqual({
      appId: "todo-list",
      localName: "create_todo",
    });
    for (const bad of ["create", "_create", "todo_", ""]) {
      expect(splitNamespacedToolName(bad), bad).toBeNull();
    }
  });

  it("uses local names on an app host and prefixed names on the gateway", () => {
    const app = todoApp();
    const tool = app.tools[0]!;
    expect(exposedToolName(appView(app), app, tool)).toBe("list_todos");
    expect(exposedToolName(gatewayView([app]), app, tool)).toBe(
      "todo_list_todos",
    );
  });

  it("resolves only names that exist on the surface", () => {
    const todo = todoApp();
    const chef = todoApp({ appId: "chef", rowId: "row_chef", name: "Chef" });
    expect(resolveToolName(appView(todo), "create_todo")?.tool.name).toBe(
      "create_todo",
    );
    expect(resolveToolName(appView(todo), "todo_create_todo")).toBeNull();

    const gateway = gatewayView([todo, chef]);
    expect(resolveToolName(gateway, "chef_list_todos")?.app.appId).toBe("chef");
    expect(resolveToolName(gateway, "create_todo")).toBeNull();
    expect(resolveToolName(gateway, "notes_list_todos")).toBeNull();
  });
});
