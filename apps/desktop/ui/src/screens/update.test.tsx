import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdatePill } from "./AppFrame";

afterEach(cleanup);

describe("UpdatePill", () => {
  it("reads Update ready with the version and restarts", () => {
    const onRestart = vi.fn();
    render(<UpdatePill version="0.2.0" kind="ready" onRestart={onRestart} />);
    const pill = screen.getByRole("status", { name: "Update" });
    expect(pill.textContent).toMatch(/Update ready · 0\.2\.0/);
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(onRestart).toHaveBeenCalledOnce();
  });

  it("reads Restart to update after a recording", () => {
    render(
      <UpdatePill version="0.2.0" kind="afterStop" onRestart={() => {}} />,
    );
    expect(screen.getByRole("status", { name: "Update" }).textContent).toMatch(
      /Restart to update/,
    );
  });
});
