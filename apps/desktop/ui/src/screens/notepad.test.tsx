import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Notepad } from "./Notepad";

afterEach(cleanup);

function Harness({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return <Notepad value={value} onChange={setValue} label="Notes" />;
}

describe("Notepad", () => {
  it("draws list markers as dots behind the text", () => {
    const { container } = render(
      <Harness initial={"- pricing\n1. first\n- [x] done"} />,
    );
    const lines = container.querySelector('[data-slot="notepad-lines"]')!;
    expect(lines.querySelectorAll('[data-part="bullet"]')).toHaveLength(2);
    expect(lines.querySelectorAll('[data-part="marker"]')).toHaveLength(2);
    expect(lines.querySelector('[data-part="done"]')?.textContent).toBe("done");
    // The drawn layer has the same text as the textarea.
    expect(lines.textContent).toBe("- pricing1. first- [x] done");
  });

  it("continues a list on Enter and indents on Tab", () => {
    render(<Harness initial="- pricing" />);
    const box = screen.getByRole("textbox", {
      name: "Notes",
    }) as HTMLTextAreaElement;
    box.setSelectionRange(9, 9);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe("- pricing\n- ");
    fireEvent.keyDown(box, { key: "Tab" });
    expect(box.value).toBe("- pricing\n  - ");
    fireEvent.keyDown(box, { key: "Tab", shiftKey: true });
    expect(box.value).toBe("- pricing\n- ");
  });
});
