import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecorderPill } from "./FloatingRecorder";

afterEach(cleanup);

// jsdom has no PointerEvent, and without one the events carry no coordinates or buttons.
(window as { PointerEvent?: unknown }).PointerEvent ??= MouseEvent;

describe("floating recorder: click or drag", () => {
  const setup = () => {
    const on = { click: vi.fn(), start: vi.fn(), end: vi.fn() };
    render(
      <RecorderPill
        level={0}
        animate={false}
        onClick={on.click}
        onDragStart={on.start}
        onDragEnd={on.end}
      />,
    );
    return { on, pill: screen.getByRole("button") };
  };
  const at = (x: number, y: number, buttons = 1) => ({
    button: 0,
    buttons,
    screenX: 1000 + x,
    screenY: 500 + y,
    clientX: x,
    clientY: y,
  });

  it("a press that barely moves is a click", () => {
    const { on, pill } = setup();
    fireEvent.pointerDown(pill, at(10, 20));
    fireEvent.pointerMove(pill, at(12, 21));
    fireEvent.pointerUp(pill, at(12, 21, 0));
    fireEvent.click(pill);
    expect(on.click).toHaveBeenCalledOnce();
    expect(on.start).not.toHaveBeenCalled();
    expect(on.end).not.toHaveBeenCalled();
  });

  it("a press that moves is a drag, from where it went down, and its release isn't a click", () => {
    const { on, pill } = setup();
    fireEvent.pointerDown(pill, at(10, 20));
    fireEvent.pointerMove(pill, at(10, 30));
    fireEvent.pointerMove(pill, at(10, 90));
    expect(on.start).toHaveBeenCalledOnce();
    expect(on.start).toHaveBeenCalledWith({ x: 10, y: 20 });
    fireEvent.pointerUp(pill, at(10, 90, 0));
    fireEvent.click(pill);
    expect(on.end).toHaveBeenCalledOnce();
    expect(on.click).not.toHaveBeenCalled();
  });

  it("ends the drag when the button came up unseen, and ignores other buttons", () => {
    const { on, pill } = setup();
    fireEvent.pointerDown(pill, { ...at(10, 20), button: 2 });
    fireEvent.pointerMove(pill, at(10, 90));
    expect(on.start).not.toHaveBeenCalled();
    fireEvent.pointerDown(pill, at(10, 20));
    fireEvent.pointerMove(pill, at(10, 90));
    fireEvent.pointerMove(pill, at(10, 95, 0));
    expect(on.end).toHaveBeenCalledOnce();
  });
});
