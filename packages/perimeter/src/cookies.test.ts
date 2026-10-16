import { describe, expect, it } from "vitest";
import { hasDuplicateSessionCookie } from "./cookies";

const NAMES = [
  "better-auth.session_token",
  "__Secure-better-auth.session_token",
] as const;

function cookies(...values: string[]): Headers {
  const headers = new Headers();
  for (const value of values) headers.append("cookie", value);
  return headers;
}

describe("hasDuplicateSessionCookie", () => {
  it("accepts a single session cookie among others", () => {
    expect(
      hasDuplicateSessionCookie(
        cookies("theme=dark; __Secure-better-auth.session_token=abc.sig; x=1"),
        NAMES,
      ),
    ).toBe(false);
    expect(hasDuplicateSessionCookie(cookies(), NAMES)).toBe(false);
    expect(hasDuplicateSessionCookie(cookies("theme=dark; x=1"), NAMES)).toBe(
      false,
    );
  });

  it("refuses the same name twice, in either order", () => {
    expect(
      hasDuplicateSessionCookie(
        cookies(
          "better-auth.session_token=mine; better-auth.session_token=tossed",
        ),
        NAMES,
      ),
    ).toBe(true);
    expect(
      hasDuplicateSessionCookie(
        cookies(
          "__Secure-better-auth.session_token=tossed;theme=dark; __Secure-better-auth.session_token=mine",
        ),
        NAMES,
      ),
    ).toBe(true);
  });

  it("counts the name with and without the __Secure- prefix as one cookie", () => {
    expect(
      hasDuplicateSessionCookie(
        cookies(
          "better-auth.session_token=tossed; __Secure-better-auth.session_token=mine",
        ),
        NAMES,
      ),
    ).toBe(true);
  });

  it("finds a copy in a second Cookie header and around stray whitespace", () => {
    expect(
      hasDuplicateSessionCookie(
        cookies(
          "__Secure-better-auth.session_token=mine",
          "  __Secure-better-auth.session_token =tossed",
        ),
        NAMES,
      ),
    ).toBe(true);
  });

  it("ignores names that only contain the session cookie's name", () => {
    expect(
      hasDuplicateSessionCookie(
        cookies(
          "__Secure-better-auth.session_token=mine; my-better-auth.session_token=x; better-auth.session_token_old=y",
        ),
        NAMES,
      ),
    ).toBe(false);
  });

  it("checks nothing without names", () => {
    expect(hasDuplicateSessionCookie(cookies("a=1; a=2"), [])).toBe(false);
  });
});
