// @vitest-environment happy-dom
/**
 * The signed-out pages carry the product's name: the same mark and wordmark
 * as the signed-in shell, without its home link.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusScreen } from "@/client/components/StatusScreen";
import { AuthCard, NoEmailResetNotice } from "./AuthPageShell";

function render(element: React.ReactElement) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(element);
  return host;
}

describe("the product lockup on signed-out pages", () => {
  it("puts the mark and the wordmark above an AuthCard's title, with no link", () => {
    const host = render(
      <AuthCard title="Sign in" footer={<p>Forgot password?</p>}>
        form
      </AuthCard>,
    );
    const image = host.querySelector("img");
    expect(image?.getAttribute("src")).toBe("/android-chrome-192x192.png");
    expect(image?.parentElement?.textContent).toBe("EveryApp");
    expect(host.querySelector("a")).toBeNull();
    expect(host.querySelector("h1")?.textContent).toBe("Sign in");
  });

  it("does the same on a StatusScreen with a logo", () => {
    const host = render(<StatusScreen logo title="Page not found" />);
    expect(host.querySelector("img")?.getAttribute("src")).toBe(
      "/android-chrome-192x192.png",
    );
    expect(host.textContent).toContain("EveryApp");
    expect(host.querySelector("a")).toBeNull();
  });
});

describe("NoEmailResetNotice", () => {
  it("sends the person to an admin instead of promising an email", () => {
    expect(render(<NoEmailResetNotice />).textContent).toBe(
      "This gateway doesn't send email. Ask an admin for a password reset link.",
    );
  });
});
