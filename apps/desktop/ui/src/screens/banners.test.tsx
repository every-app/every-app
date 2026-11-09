import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OfflineBanner, SignInAgainBanner } from "./Banners";

afterEach(cleanup);

describe("connection banners", () => {
  it("says offline quietly", () => {
    render(<OfflineBanner />);
    expect(screen.getByRole("status").textContent).toBe(
      "Offline. Recording continues, and notes sync when you're back.",
    );
  });

  it("signs in again with Every App, and shows the wait and the error", () => {
    const onSignIn = vi.fn();
    const { rerender } = render(
      <SignInAgainBanner kind="oauth" signingIn={false} onSignIn={onSignIn} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
    expect(onSignIn).toHaveBeenCalledOnce();
    const onCancel = vi.fn();
    rerender(
      <SignInAgainBanner
        kind="oauth"
        signingIn
        onSignIn={onSignIn}
        onCancel={onCancel}
        error="Sign-in was cancelled."
      />,
    );
    expect(screen.getByText("Waiting for your browser…")).toBeTruthy();
    expect(screen.getByText("Sign-in was cancelled.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("takes a new token for a token sign-in", () => {
    const onSubmitToken = vi.fn();
    render(<SignInAgainBanner kind="token" onSubmitToken={onSubmitToken} />);
    const submit = screen.getByRole("button", {
      name: "Sign in",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("New access token"), {
      target: { value: " epat_new " },
    });
    fireEvent.click(submit);
    expect(onSubmitToken).toHaveBeenCalledWith("epat_new");
  });
});
