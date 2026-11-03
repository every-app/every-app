/** `everyapp call`'s arguments: one JSON object, from the command line or stdin (`-`), or none. */
import { describe, expect, it, vi } from "vitest";
import { parseArguments } from "./index";

describe("parseArguments", () => {
  it("takes one JSON object, nothing as {}, and - from stdin", async () => {
    const stdin = vi.fn(async () => '{"email":"ann@example.com"}');
    expect(await parseArguments(undefined, stdin)).toEqual({});
    expect(await parseArguments("  ", stdin)).toEqual({});
    expect(await parseArguments('{"role":"admin"}', stdin)).toEqual({ role: "admin" });
    expect(stdin).not.toHaveBeenCalled();
    expect(await parseArguments("-", stdin)).toEqual({ email: "ann@example.com" });
  });

  it("refuses what isn't JSON, an array and a plain value", async () => {
    for (const raw of ["{email:", "[1,2]", '"text"', "42", "null"]) {
      await expect(parseArguments(raw, async () => "")).rejects.toMatchObject({ code: "INVALID_VALUE" });
    }
    await expect(parseArguments("-", async () => "[]")).rejects.toMatchObject({ code: "INVALID_VALUE" });
  });
});
