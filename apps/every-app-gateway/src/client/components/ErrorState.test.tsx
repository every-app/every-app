// @vitest-environment happy-dom
/**
 * The one failure message, in its three placements: the text a reader sees
 * and the retry button, so every page that fails to load reads the same.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ErrorState } from "./ErrorState";

function render(element: React.ReactElement) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(element);
  return host;
}

describe("ErrorState", () => {
  it("names what failed and offers to try again, as a card", () => {
    const host = render(
      <ErrorState message="Couldn't load users." onRetry={() => {}} />,
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't load users.",
    );
    expect(host.querySelector("button")?.textContent).toBe("Try again");
  });

  it("is red text with a small button inline", () => {
    const host = render(
      <ErrorState
        variant="inline"
        message="Couldn't load tools."
        onRetry={() => {}}
      />,
    );
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.className).toContain("text-destructive");
    expect(alert?.textContent).toBe("Couldn't load tools.Try again");
  });

  it("fills a page with a title, the message, the detail and the buttons", () => {
    const host = render(
      <ErrorState
        variant="page"
        message="Please try again."
        detail="INTERNAL_ERROR"
        onRetry={() => {}}
        action={<a href="/">Go home</a>}
      />,
    );
    const text = host.textContent ?? "";
    expect(text).toContain("Something went wrong");
    expect(text).toContain("Please try again.");
    expect(text).toContain("INTERNAL_ERROR");
    expect(host.querySelector("button")?.textContent).toBe("Try again");
    expect(host.querySelector("a")?.textContent).toBe("Go home");
  });

  it("shows no button without a retry or an action", () => {
    const host = render(<ErrorState message="Couldn't load usage." />);
    expect(host.querySelector("button")).toBeNull();
  });
});
