import { describe, expect, it } from "vitest";
import { clientSourceLabel, scopesText, splitList } from "./oauthProviders";

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
