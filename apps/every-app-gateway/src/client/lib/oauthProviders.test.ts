import { describe, expect, it } from "vitest";
import {
  compareConnections,
  connectionName,
  scopesText,
  splitList,
} from "./oauthProviders";

describe("the words", () => {
  it("name a connection's scopes, or say it holds none", () => {
    expect(scopesText([])).toBe("no scopes");
    expect(scopesText(["gmail.modify", "gmail.send"])).toBe(
      "gmail.modify, gmail.send",
    );
  });

  it("split a list field on spaces and commas", () => {
    expect(splitList(" api.acme.com, files.acme.com  x ")).toEqual([
      "api.acme.com",
      "files.acme.com",
      "x",
    ]);
  });
});

describe("a connected account", () => {
  const github = {
    providerId: "github-oauth",
    providerName: "GitHub",
    label: "ada",
    apps: [{ id: "crm", name: "CRM" }],
    needsReconnect: false,
  };
  const mcp = {
    providerId: "elevenlabs-mcp-mcp",
    providerName: "elevenlabs-mcp MCP server",
    label: null,
    apps: [{ id: "elevenlabs-mcp", name: "ElevenLabs" }],
    needsReconnect: false,
  };

  it("is named by its provider and account, and an app's MCP server by the app", () => {
    expect(connectionName(github)).toEqual({
      title: "GitHub",
      subtitle: "ada",
    });
    expect(connectionName(mcp)).toEqual({
      title: "ElevenLabs",
      subtitle: "MCP server",
    });
    // No app of its own allowed: the provider's name stays.
    expect(connectionName({ ...mcp, apps: [] }).title).toBe(
      "elevenlabs-mcp MCP server",
    );
  });

  it("lists the ones that need reconnecting first, then by name", () => {
    const google = { ...github, providerName: "Google", label: "ada@acme.com" };
    expect(
      [google, github, { ...mcp, needsReconnect: true }]
        .sort(compareConnections)
        .map((c) => connectionName(c).title),
    ).toEqual(["ElevenLabs", "GitHub", "Google"]);
  });
});
