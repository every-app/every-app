/**
 * The held-token boundary (docs/design/2026-10-oauth-providers.md section
 * 7) and the two plain scope dialects: what a connection's sets let an
 * app call, and how a `space` or `comma` provider's token answer is read.
 */
import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "./capabilities";
import { OAUTH_PRESETS } from "./oauthPresets";
import {
  grantedScopes,
  grantedScopesOrRequested,
  heldTokenCallAllowed,
} from "./oauthScopes";
import { parseProviderSpec } from "./providerSpec";

function policyOf(spec: Record<string, unknown>) {
  const parsed = parseProviderSpec(spec);
  if (!parsed.ok || parsed.capability.mode !== "oauth_client") {
    throw new Error("parses");
  }
  return {
    capability: parsed.capability,
    policy: parsed.capability.scopePolicy!,
  };
}

describe("the space and comma dialects", () => {
  const github = policyOf(OAUTH_PRESETS["github-oauth"]!).policy;
  const zoom = policyOf(OAUTH_PRESETS["zoom"]!).policy;

  it("split a scope field on commas (and spaces) or spaces alone", () => {
    expect(
      grantedScopes(github, { access_token: "t", scope: "repo,read:user" }),
    ).toEqual({
      scopes: ["repo", "read:user"],
    });
    expect(
      grantedScopes(github, { access_token: "t", scope: "repo, read:user" }),
    ).toEqual({
      scopes: ["repo", "read:user"],
    });
    expect(
      grantedScopes(zoom, {
        access_token: "t",
        scope: "user:read:user meeting:read:meeting",
      }),
    ).toEqual({ scopes: ["user:read:user", "meeting:read:meeting"] });
    expect(grantedScopes(zoom, { access_token: "t" })).toBeNull();
  });

  it("take a token with no scope field as granted-as-requested, for these two dialects only", () => {
    const requested = { scopes: ["repo", "read:user"], userScopes: [] };
    expect(
      grantedScopesOrRequested(github, { access_token: "t" }, requested),
    ).toEqual({ scopes: ["repo", "read:user"] });
    // A scope field that is present but names nothing is still a refusal.
    expect(
      grantedScopesOrRequested(
        github,
        { access_token: "t", scope: "" },
        requested,
      ),
    ).toBeNull();
    const google = CAPABILITIES["google-workspace"].scopePolicy;
    expect(
      grantedScopesOrRequested(google, { access_token: "t" }, requested),
    ).toBeNull();
  });
});

describe("heldTokenCallAllowed", () => {
  const { capability, policy } = policyOf(OAUTH_PRESETS["github-oauth"]!);
  const call = (
    method: string,
    url: string,
    overrides: Partial<Parameters<typeof heldTokenCallAllowed>[0]> = {},
  ) =>
    heldTokenCallAllowed({
      policy,
      declaredSets: ["repo.read"],
      connectionSets: ["identity", "repo.read"],
      hosts: capability.api,
      method,
      upstream: new URL(url),
      writes: false,
      ...overrides,
    });

  it("lets a read through on a declared set without routes, on the provider's hosts", () => {
    expect(call("GET", "https://api.github.com/user/repos")).toEqual({
      ok: true,
      set: "repo.read",
    });
    expect(call("HEAD", "https://api.github.com/repos/a/b")).toEqual({
      ok: true,
      set: "repo.read",
    });
  });

  it("refuses a set the connection was not granted, naming it", () => {
    expect(
      call("GET", "https://api.github.com/user", {
        declaredSets: ["identity", "repo.write"],
      }),
    ).toEqual({
      ok: false,
      code: "integration_not_connected",
      missingSets: ["repo.write"],
    });
  });

  it("refuses another host, http, and a path no set unlocks", () => {
    expect(call("GET", "https://github.com/login")).toMatchObject({
      ok: false,
      code: "integration_scope_not_allowed",
    });
    expect(call("GET", "http://api.github.com/user")).toMatchObject({
      ok: false,
      code: "integration_scope_not_allowed",
    });
    expect(call("GET", "https://api.github.com/batch/x")).toMatchObject({
      ok: false,
      code: "integration_scope_not_allowed",
      message: "/batch/x is a path no scope set unlocks.",
    });
    expect(call("GET", "https://api.github.com/a/%252e%252e/b")).toMatchObject({
      ok: false,
      code: "integration_scope_not_allowed",
    });
  });

  it("lets a write through only on a declared write set, when the grant allows the method", () => {
    expect(
      call("POST", "https://api.github.com/repos/a/b/issues", {
        declaredSets: ["repo.write"],
        connectionSets: ["repo.write"],
        writes: true,
      }),
    ).toEqual({ ok: true, set: "repo.write" });
    expect(
      call("POST", "https://api.github.com/repos/a/b/issues", {
        declaredSets: ["repo.read"],
        writes: true,
      }),
    ).toMatchObject({ ok: false, code: "integration_scope_not_allowed" });
    expect(
      call("POST", "https://api.github.com/repos/a/b/issues", {
        declaredSets: ["repo.write"],
        connectionSets: ["repo.write"],
        writes: false,
      }),
    ).toMatchObject({ ok: false, code: "integration_method_not_allowed" });
  });

  it("lets a read-shaped POST through on a read set that lists it, as Dropbox's and Notion's do", () => {
    const dropbox = policyOf(OAUTH_PRESETS["dropbox"]!);
    const post = (path: string, host = "api.dropboxapi.com") =>
      heldTokenCallAllowed({
        policy: dropbox.policy,
        declaredSets: ["files.read"],
        connectionSets: ["files.read"],
        hosts: dropbox.capability.api,
        method: "POST",
        upstream: new URL(`https://${host}${path}`),
        writes: false,
      });
    expect(post("/2/files/list_folder")).toEqual({
      ok: true,
      set: "files.read",
    });
    expect(post("/2/files/download", "content.dropboxapi.com")).toEqual({
      ok: true,
      set: "files.read",
    });
    expect(post("/2/files/delete_v2")).toMatchObject({
      ok: false,
      code: "integration_method_not_allowed",
    });
    const notion = policyOf(OAUTH_PRESETS["notion-oauth"]!);
    const notionPost = (path: string) =>
      heldTokenCallAllowed({
        policy: notion.policy,
        declaredSets: ["workspace.read"],
        connectionSets: ["workspace.read"],
        hosts: notion.capability.api,
        method: "POST",
        upstream: new URL(`https://api.notion.com${path}`),
        writes: false,
      });
    expect(notionPost("/v1/search")).toEqual({
      ok: true,
      set: "workspace.read",
    });
    expect(notionPost("/v1/databases/abc/query")).toEqual({
      ok: true,
      set: "workspace.read",
    });
    expect(notionPost("/v1/pages")).toMatchObject({
      ok: false,
      code: "integration_method_not_allowed",
    });
  });

  it("uses a set's routes when it has them, as the catalog's Google sets do", () => {
    const google = CAPABILITIES["google-workspace"];
    const allowed = heldTokenCallAllowed({
      policy: google.scopePolicy,
      declaredSets: ["search-console.read"],
      connectionSets: ["identity", "search-console.read"],
      hosts: google.api,
      method: "GET",
      upstream: new URL(
        "https://searchconsole.googleapis.com/webmasters/v3/sites",
      ),
      writes: false,
    });
    expect(allowed).toEqual({ ok: true, set: "search-console.read" });
    const refused = heldTokenCallAllowed({
      policy: google.scopePolicy,
      declaredSets: ["search-console.read"],
      connectionSets: ["identity", "search-console.read"],
      hosts: google.api,
      method: "GET",
      upstream: new URL(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      ),
      writes: false,
    });
    expect(refused).toMatchObject({
      ok: false,
      code: "integration_scope_not_allowed",
    });
  });
});
