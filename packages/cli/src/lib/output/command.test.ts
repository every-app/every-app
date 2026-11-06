import { describe, expect, it } from "vitest";
import { invocation, thisCommand, thisCommandInstead, thisCommandWithout } from "./command";

describe("invocation", () => {
  it("is how the person ran everyapp: through their package manager, or directly", () => {
    expect(
      invocation({ npm_config_user_agent: "pnpm/10.34.5 npm/? node/v24.22.0 darwin arm64" }),
    ).toBe("pnpm everyapp");
    expect(invocation({ npm_config_user_agent: "npm/10.9.2 node/v22.18.0 darwin arm64" })).toBe(
      "npx everyapp",
    );
    expect(invocation({})).toBe("everyapp");
  });
});

describe("thisCommand", () => {
  it("keeps --json when the run had it, so an agent runs the rerun as it is", () => {
    expect(thisCommand([], { argv: ["setup", "--domain", "apps.example.com", "--json"] })).toBe(
      "pnpm everyapp setup --domain apps.example.com --json",
    );
    expect(thisCommand(["--force-dns"], { argv: ["deploy", "--json"] })).toBe(
      "pnpm everyapp deploy --json --force-dns",
    );
  });

  it("leaves --json out of a rerun only a person at a terminal can do", () => {
    expect(thisCommand([], { terminal: true, argv: ["deploy", "--json"] })).toBe(
      "pnpm everyapp deploy",
    );
    expect(
      thisCommand([], { terminal: true, argv: ["secret", "set", "GITHUB_TOKEN", "--json"] }),
    ).toBe("pnpm everyapp secret set GITHUB_TOKEN");
  });

  it("is a person's command as given, with the flags it doesn't have yet, each once", () => {
    expect(thisCommand([], { argv: ["setup", "--domain", "apps.example.com"] })).toBe(
      "pnpm everyapp setup --domain apps.example.com",
    );
    expect(thisCommand([], { terminal: true, argv: ["deploy"] })).toBe("pnpm everyapp deploy");
    expect(thisCommand(["--force-dns"], { argv: ["deploy"] })).toBe(
      "pnpm everyapp deploy --force-dns",
    );
    expect(thisCommand(["--force-dns"], { argv: ["deploy", "--force-dns"] })).toBe(
      "pnpm everyapp deploy --force-dns",
    );
    expect(thisCommand(["--yes"], { argv: ["delete", "todo", "--yes"] })).toBe(
      "pnpm everyapp delete todo --yes",
    );
  });

  it("quotes an argument a POSIX shell would read differently", () => {
    expect(thisCommand([], { argv: ["email", "set", "--inbound", "*@example.com"] })).toBe(
      "pnpm everyapp email set --inbound '*@example.com'",
    );
    expect(thisCommand([], { argv: ["db", "query", "SELECT * FROM t WHERE a = 'x'"] })).toBe(
      `pnpm everyapp db query 'SELECT * FROM t WHERE a = '\\''x'\\'''`,
    );
  });
});

describe("thisCommandWithout", () => {
  it("drops the flag and its value, in either spelling, and keeps --json", () => {
    expect(thisCommandWithout("--domain", ["setup", "--domain", "apps.example.com", "--json"])).toBe(
      "pnpm everyapp setup --json",
    );
    expect(thisCommandWithout("--domain", ["setup", "--domain=apps.example.com"])).toBe(
      "pnpm everyapp setup",
    );
  });
});

describe("thisCommandInstead", () => {
  const replaced = ["--account-id", "--gateway"];

  it("adds the flags to a run that had none of them", () => {
    expect(thisCommandInstead(replaced, ["--account-id", "a"], ["status", "--json"])).toBe(
      "pnpm everyapp status --json --account-id a",
    );
  });

  it("replaces each flag in either spelling, leaving no stray value", () => {
    expect(
      thisCommandInstead(replaced, ["--account-id", "a", "--gateway", "https://b.dev"], [
        "update",
        "--gateway",
        "https://old.dev",
        "--account-id=old",
        "--json",
      ]),
    ).toBe("pnpm everyapp update --json --account-id a --gateway https://b.dev");
  });
});

describe("thisCommandWithout a flag that has no value", () => {
  it("keeps the flag after it", () => {
    expect(thisCommandWithout("--gateway", ["db", "restore", "--gateway", "--json"])).toBe(
      "pnpm everyapp db restore --json",
    );
  });
});
