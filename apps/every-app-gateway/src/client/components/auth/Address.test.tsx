// @vitest-environment happy-dom
/**
 * An email address in a sentence stays in one piece: the markup that keeps
 * "someone-else@example.com" from breaking at its hyphen, with the comma
 * after it inside the same piece.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Address, withAddresses } from "./Address";

function render(element: React.ReactElement) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(element);
  return host;
}

describe("Address", () => {
  it("is an atomic inline that may only break when wider than the line, with its punctuation inside", () => {
    const host = render(<Address after=",">someone-else@example.com</Address>);
    const span = host.querySelector("span");
    expect(span?.className).toContain("inline-block");
    expect(span?.className).toContain("wrap-anywhere");
    expect(span?.textContent).toBe("someone-else@example.com,");
    expect(span?.querySelector("strong")?.textContent).toBe(
      "someone-else@example.com",
    );
  });
});

describe("withAddresses", () => {
  it("wraps every address in a message, keeping the punctuation after it and not a sentence's full stop", () => {
    const host = render(
      <p>
        {withAddresses(
          "You're signed in to Cloudflare Access as alice@acme.com, but this account is bob-smith@partner.example. Ask an admin to invite alice@acme.com.",
        )}
      </p>,
    );
    const pieces = [...host.querySelectorAll("span")].map((s) => s.textContent);
    expect(pieces).toEqual([
      "alice@acme.com,",
      "bob-smith@partner.example.",
      "alice@acme.com.",
    ]);
    const addresses = [...host.querySelectorAll("strong")].map(
      (s) => s.textContent,
    );
    expect(addresses).toEqual([
      "alice@acme.com",
      "bob-smith@partner.example",
      "alice@acme.com",
    ]);
    expect(host.textContent).toBe(
      "You're signed in to Cloudflare Access as alice@acme.com, but this account is bob-smith@partner.example. Ask an admin to invite alice@acme.com.",
    );
  });

  it("leaves a message with no address alone", () => {
    expect(withAddresses("Invalid email or password.")).toBe(
      "Invalid email or password.",
    );
  });
});
