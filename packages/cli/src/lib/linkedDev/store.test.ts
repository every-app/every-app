import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linkedDevStorePath, openLinkedDevStore, type LinkedDevEntry } from "./store";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-linked-dev-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const entry = (over: Partial<LinkedDevEntry> = {}): LinkedDevEntry => ({
  gateway: "https://apps.example.com",
  appId: "todo",
  clientId: "client-1",
  refreshToken: "rt-1",
  accessToken: "at-1",
  expiresAt: "2026-10-28T01:00:00.000Z",
  linkedAt: "2026-10-28T00:00:00.000Z",
  ...over,
});

describe("the linked dev store", () => {
  it("lives under $XDG_CONFIG_HOME/everyapp, else ~/.config/everyapp", () => {
    expect(linkedDevStorePath({ XDG_CONFIG_HOME: "/x" })).toBe("/x/everyapp/linked-dev.json");
    expect(linkedDevStorePath({})).toBe(path.join(os.homedir(), ".config", "everyapp", "linked-dev.json"));
  });

  it("keeps one entry per Gateway and app, owner-only, and forgets on remove", () => {
    const file = path.join(dir, "nested", "linked-dev.json");
    const store = openLinkedDevStore(file);
    expect(store.get("https://apps.example.com", "todo")).toBeNull();
    store.put(entry());
    store.put(entry({ appId: "notes", accessToken: "at-notes" }));
    store.put(entry({ accessToken: "at-2" }));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(store.list().map((item) => [item.appId, item.accessToken])).toEqual([
      ["notes", "at-notes"],
      ["todo", "at-2"],
    ]);
    expect(store.remove("https://apps.example.com", "todo")?.accessToken).toBe("at-2");
    expect(store.remove("https://apps.example.com", "todo")).toBeNull();
    expect(store.get("https://apps.example.com", "notes")?.accessToken).toBe("at-notes");
  });

  it("treats an unreadable file as empty", () => {
    const file = path.join(dir, "linked-dev.json");
    fs.writeFileSync(file, "{not json");
    expect(openLinkedDevStore(file).list()).toEqual([]);
    fs.writeFileSync(file, JSON.stringify({ v: 2, entries: [entry()] }));
    expect(openLinkedDevStore(file).list()).toEqual([]);
  });
});
