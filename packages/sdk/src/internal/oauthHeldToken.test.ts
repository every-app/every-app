/**
 * The held-token boundary for a registered OAuth provider (a preset's
 * row): the token goes to the spec's hosts and nowhere else, and a
 * token answer is read by the spec's own scope spelling. No routes, sets
 * or methods: what an app may do is what its scopes let it do.
 */
import { describe, expect, it } from "vitest";
import {
  integrationProxyPath,
  parseIntegrationProxyPath,
} from "./capabilities";
import { OAUTH_PRESETS } from "./oauthPresets";
import {
  grantedScopes,
  missingScopes,
  requestedScopes,
  scopeExcess,
} from "./oauthScopes";
import { providerRegistry } from "./providerRegistry";
import { parseProviderSpec } from "./providerSpec";

function flowOf(id: string) {
  const parsed = parseProviderSpec(OAUTH_PRESETS[id]);
  if (!parsed.ok || parsed.capability.mode !== "oauth_client") {
    throw new Error(`${id} parses`);
  }
  return parsed.capability.flow;
}

describe("a registered provider's hosts", () => {
  const registry = providerRegistry([
    { id: "dropbox", spec: OAUTH_PRESETS["dropbox"] },
  ]);
  const parse = (url: string) => {
    const path = new URL(
      integrationProxyPath("dropbox", new URL(url)),
      "http://gateway.internal",
    );
    return parseIntegrationProxyPath(
      path.pathname,
      path.search,
      undefined,
      registry,
    );
  };

  it("takes any method's call to each of the spec's API hosts", () => {
    for (const url of [
      "https://api.dropboxapi.com/2/files/list_folder",
      "https://content.dropboxapi.com/2/files/upload",
    ]) {
      expect(parse(url)).toMatchObject({
        kind: "oauth_client",
        id: "dropbox",
        upstream: new URL(url),
      });
    }
  });

  it("refuses the authorize host and anything else", () => {
    expect(parse("https://www.dropbox.com/oauth2/authorize")).toBeNull();
    expect(parse("https://attacker.example/2/files")).toBeNull();
  });
});

describe("a preset's scope spelling", () => {
  it("GitHub: a comma answer, held to what the app asked", () => {
    const github = flowOf("github-oauth");
    const asked = requestedScopes(github, ["repo"]);
    expect(asked).toEqual(["repo"]);
    const granted = grantedScopes(github, { scope: "repo,read:org" }, asked);
    expect(scopeExcess(github, granted!, asked)).toEqual(["read:org"]);
    expect(
      scopeExcess(
        github,
        grantedScopes(github, { scope: "repo" }, asked)!,
        asked,
      ),
    ).toEqual([]);
  });

  it("Notion: no scopes at all, and an answer without a scope field", () => {
    const notion = flowOf("notion-oauth");
    const asked = requestedScopes(notion, []);
    expect(asked).toEqual([]);
    const granted = grantedScopes(notion, { access_token: "t" }, asked);
    expect(granted).toEqual([]);
    expect(scopeExcess(notion, granted!, asked)).toEqual([]);
    expect(missingScopes(notion, granted!, [])).toEqual([]);
  });

  it("Atlassian: identity scopes added to every connect, and allowed back", () => {
    const atlassian = flowOf("atlassian");
    const asked = requestedScopes(atlassian, ["read:jira-work"]);
    expect(asked).toEqual(["read:jira-work", "read:me", "offline_access"]);
    const granted = grantedScopes(
      atlassian,
      { scope: "read:jira-work read:me offline_access" },
      asked,
    );
    expect(scopeExcess(atlassian, granted!, asked)).toEqual([]);
  });

  it("Dropbox: a tolerated scope the provider grants every app", () => {
    const dropbox = flowOf("dropbox");
    const asked = requestedScopes(dropbox, ["files.content.read"]);
    const granted = grantedScopes(
      dropbox,
      { scope: "account_info.read files.content.read" },
      asked,
    );
    expect(scopeExcess(dropbox, granted!, asked)).toEqual([]);
  });
});
