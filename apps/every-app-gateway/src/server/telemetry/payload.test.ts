/**
 * What the usage report may hold, checked without a database: its keys are
 * the receiver's example's keys, its app names are the receiver's, and the
 * file that builds it reads none of the columns that could say whose
 * Gateway this is. telemetry.sqlite.test.ts builds a real one.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));

import { NAMED_APPS, roundDown } from "./payload";

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const source = read("./payload.ts");
const example = JSON.parse(
  read("../../../../telemetry/example-report.json"),
) as Record<string, unknown>;

/** The keys of an interface in payload.ts, in order. */
function keysOf(name: string): string[] {
  const body = new RegExp(`interface ${name} \\{([^}]*)\\}`).exec(source)?.[1];
  if (!body) throw new Error(`no interface ${name}`);
  return [...body.matchAll(/^\s*(\w+)\??:/gm)].map((match) => match[1]!);
}

describe("the usage report", () => {
  it("has exactly the keys of the receiver's example", () => {
    expect(keysOf("UsageReport")).toEqual(Object.keys(example));
    expect(keysOf("AppUse")).toEqual(
      Object.keys((example["app_use_1d"] as object[])[0]!),
    );
  });

  it("names only the apps the receiver accepts", () => {
    const receiver = read("../../../../telemetry/src/index.ts");
    const accepted = /const APPS = new Set\(\[([^\]]*)\]\)/.exec(receiver)?.[1];
    expect(
      [...(accepted ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]),
    ).toEqual([...NAMED_APPS, "other"]);
  });

  it("reads no column that could say whose Gateway this is", () => {
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    // Tables it may read, and nothing else from the schema.
    expect(
      /import \{([^}]*)\} from "@\/db\/schema"/.exec(code)?.[1]?.match(/\w+/g),
    ).toEqual([
      "apps",
      "mcpToolCalls",
      "members",
      "organizations",
      "sessions",
      "usageDaily",
    ]);
    for (const forbidden of [
      "_everyapp_install",
      "users.",
      " users",
      ".name",
      "organizations.slug",
      ".email",
      ".hostname",
      ".workerName",
      ".manifest",
      ".description",
      ".toolName",
      ".clientName",
      ".clientInfo",
      ".ipAddress",
      ".userAgent",
      ".token",
      "select()",
      "fetch(",
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it("rounds every count down to one significant digit", () => {
    expect([0, 7, 10, 37, 99, 100, 4812].map((n) => roundDown(n))).toEqual([
      0, 7, 10, 30, 90, 100, 4000,
    ]);
    expect(roundDown(2500, 1000)).toBe(1000);
  });
});
