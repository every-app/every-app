import { describe, expect, it } from "vitest";
import { describeClient } from "./server";

describe("describeClient", () => {
  it("joins the client's name and version with one space", () => {
    expect(describeClient({ name: "claude-code", version: "2.1.304" })).toBe(
      "claude-code 2.1.304",
    );
    expect(
      describeClient({ name: "Cursor", version: "", title: "Cursor" }),
    ).toBe("Cursor");
    expect(describeClient({ name: "Cursor" })).toBe("Cursor");
  });

  it("is undefined without a visible name, or for anything that isn't an Implementation", () => {
    expect(describeClient(undefined)).toBeUndefined();
    expect(describeClient(null)).toBeUndefined();
    expect(describeClient("claude-code")).toBeUndefined();
    expect(describeClient({ version: "1" })).toBeUndefined();
    expect(describeClient({ name: " \u0000 ", version: "1" })).toBeUndefined();
    expect(describeClient({ name: 7, version: "1" })).toBeUndefined();
  });

  it("cuts a 300-character name to 100 and the version to 50", () => {
    const text = describeClient({
      name: "n".repeat(300),
      version: "v".repeat(300),
    })!;
    expect(text).toBe(`${"n".repeat(100)} ${"v".repeat(50)}`);
    expect(text.length).toBeLessThanOrEqual(200);
  });

  it("strips control characters and collapses whitespace", () => {
    expect(
      describeClient({
        name: "claude\u0000\u0007-code\n\n  x\u009f",
        version: "\t1\r\n.0 ",
      }),
    ).toBe("claude -code x 1 .0");
  });

  it("counts characters, not UTF-16 units, when cutting", () => {
    expect(describeClient({ name: "😀".repeat(120), version: "1" })).toBe(
      `${"😀".repeat(100)} 1`,
    );
  });
});
