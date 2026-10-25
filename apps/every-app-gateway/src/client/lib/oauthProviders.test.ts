import { describe, expect, it } from "vitest";
import {
  callbackNotice,
  clientSourceLabel,
  connectErrorText,
  connectPathFor,
  scopeSetsText,
} from "./oauthProviders";

describe("connectPathFor", () => {
  it("builds the Gateway's connect path with the account, return and sets", () => {
    expect(connectPathFor("github-oauth", { account: "user" })).toBe(
      "/connect/github-oauth?account=user",
    );
    expect(
      connectPathFor("github-oauth", {
        account: "organization",
        returnTo: "/admin/providers",
        sets: ["identity", "repo.read"],
      }),
    ).toBe(
      "/connect/github-oauth?account=organization&return=%2Fadmin%2Fproviders&sets=identity%2Crepo.read",
    );
  });

  it("encodes the id and drops empty sets", () => {
    expect(connectPathFor("a b", { account: "user", sets: [] })).toBe(
      "/connect/a%20b?account=user",
    );
  });
});

describe("the words", () => {
  it("say where the client comes from, never its value", () => {
    expect(clientSourceLabel({ source: "env" })).toEqual({
      label: "Set from the terminal",
      tone: "set",
    });
    expect(clientSourceLabel({ source: "d1" })).toEqual({
      label: "Pasted here",
      tone: "set",
    });
    expect(clientSourceLabel({ source: null })).toEqual({
      label: "No client",
      tone: "unset",
    });
  });

  it("turn the callback's query into one notice", () => {
    expect(callbackNotice({})).toBeNull();
    expect(callbackNotice({ connected: "GitHub" })).toEqual({
      kind: "success",
      text: "GitHub connected.",
    });
    expect(callbackNotice({ error: "access_denied" })).toEqual({
      kind: "error",
      text: connectErrorText("access_denied"),
    });
    expect(connectErrorText("something_else")).toBe(
      "Couldn't connect (something_else).",
    );
  });

  it("name the scope sets or the default", () => {
    expect(scopeSetsText([])).toBe("default");
    expect(scopeSetsText(["identity", "repo.read"])).toBe(
      "identity, repo.read",
    );
  });
});
