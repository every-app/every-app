import { describe, expect, it } from "vitest";
import {
  accessSummary,
  accessWords,
  appsToName,
  compareConnections,
  connectionName,
  namesText,
  partialGrant,
  scopesText,
  splitList,
} from "./oauthProviders";

describe("a connection granted in part", () => {
  it("says how much of what its apps list was granted, and nothing when that is all of it", () => {
    expect(partialGrant({ permissions: { listed: 18, granted: 10 } })).toBe(
      "10 of 18 granted",
    );
    expect(partialGrant({ permissions: { listed: 2, granted: 2 } })).toBeNull();
    expect(partialGrant({ permissions: null })).toBeNull();
    // Beside the words where they say something, in place of a bare count.
    const autumn = { listed: 18, granted: 10 };
    expect(
      accessWords({
        providerId: "autumn-mcp",
        scopes: ["openid", "offline_access", "a:read", "b:read"],
        permissions: autumn,
      }),
    ).toEqual({ words: "Read only", partial: "10 of 18 granted" });
    expect(
      accessWords({
        providerId: "x",
        scopes: ["repo"],
        permissions: { listed: 2, granted: 1 },
      }),
    ).toEqual({ words: "1 of 2 permissions", partial: null });
  });
});

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
      mark: "github-oauth",
      mcp: false,
    });
    expect(connectionName(mcp)).toEqual({
      title: "ElevenLabs",
      subtitle: null,
      mark: "elevenlabs",
      mcp: true,
    });
    // No app of its own allowed: the provider's name stays.
    expect(connectionName({ ...mcp, apps: [] }).title).toBe(
      "elevenlabs-mcp MCP server",
    );
  });

  it("gives an app nobody named the product's own spelling, when its id is a known product's", () => {
    const unnamed = (id: string) =>
      connectionName({
        ...mcp,
        providerId: `${id}-mcp`,
        apps: [{ id, name: id }],
      }).title;
    expect(unnamed("elevenlabs-mcp")).toBe("ElevenLabs");
    expect(unnamed("stripe")).toBe("Stripe");
    expect(unnamed("pscale")).toBe("PlanetScale");
    // Not a known product: its own name stays.
    expect(unnamed("treg")).toBe("treg");
    // A name the person gave wins.
    expect(
      connectionName({
        ...mcp,
        providerId: "stripe-mcp",
        apps: [{ id: "stripe", name: "Billing" }],
      }).title,
    ).toBe("Billing");
  });

  it("names the apps that use it only when that says something", () => {
    expect(appsToName(mcp)).toEqual([]);
    expect(appsToName(github)).toEqual(github.apps);
    const shared = {
      ...mcp,
      apps: [...mcp.apps, { id: "crm", name: "CRM" }],
    };
    expect(appsToName(shared)).toEqual(shared.apps);
    expect(namesText(["OpenMail"])).toBe("OpenMail");
    expect(namesText(["OpenMail", "Scribe"])).toBe("OpenMail and Scribe");
    expect(namesText(["A", "B", "C"])).toBe("A, B and C");
  });

  it("says what its scopes allow in plain words only where they say so themselves", () => {
    const summary = (scopes: string[], providerId = "acme") =>
      accessSummary({ providerId, scopes });
    expect(summary(["api.read", "api.write"])).toBe("Read and write");
    expect(summary(["a:read", "read_b", "c.readonly"])).toBe("Read only");
    expect(summary(["a:write"])).toBe("Write only");
    // One scope it can't read, and the whole list is a count.
    expect(summary(["convai_read", "convai_write", "text_to_speech"])).toBe(
      "3 permissions",
    );
    expect(summary(["mcp"])).toBe("1 permission");
    expect(summary([])).toBe("None");
    expect(summary(["openid", "email", "profile"])).toBe("Basic profile");
    // Google's by product, the scopes that only identify the person left out.
    expect(
      summary(
        ["gmail.modify", "calendar.readonly", "gmail.send", "userinfo.email"],
        "google-workspace",
      ),
    ).toBe("Calendar and Gmail");
    expect(summary(["gmail.send", "cloud-platform"], "google-workspace")).toBe(
      "2 permissions",
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
