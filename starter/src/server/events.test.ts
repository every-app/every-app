import { beforeEach, describe, expect, it, vi } from "vitest";

const emit = vi.hoisted(() => vi.fn());
vi.mock("@every-app/sdk/server", () => ({ emit }));

const { emitIfCompleted } = await import("./events");

describe("emitIfCompleted", () => {
  const env = { EVERYAPP_DEV: "1" };
  const request = new Request("https://app.example/");
  let waited: Promise<unknown>[];
  const scope = () => ({
    env,
    request,
    waitUntil: (promise: Promise<unknown>) => void waited.push(promise),
  });

  beforeEach(() => {
    emit.mockReset().mockResolvedValue({ id: "evt_1" });
    waited = [];
  });

  it("emits todo.completed with the id only, under waitUntil", async () => {
    emitIfCompleted(scope(), { completed: true }, { id: "t1" });

    expect(emit).toHaveBeenCalledWith({
      env,
      for: request,
      event: "todo.completed",
      data: { todoId: "t1" },
    });
    expect(waited).toHaveLength(1);
    await expect(waited[0]).resolves.toEqual({ id: "evt_1" });
  });

  it("stays quiet unless a todo of this user was marked done", () => {
    emitIfCompleted(scope(), { completed: false }, { id: "t1" });
    emitIfCompleted(scope(), {}, { id: "t1" });
    emitIfCompleted(scope(), { completed: true }, null);

    expect(emit).not.toHaveBeenCalled();
    expect(waited).toEqual([]);
  });

  it("never throws into the change when the emit is refused", async () => {
    emit.mockRejectedValue(new Error("event_rate_limited"));

    expect(() =>
      emitIfCompleted(scope(), { completed: true }, { id: "t1" }),
    ).not.toThrow();
    await expect(waited[0]).rejects.toThrow("event_rate_limited");
  });
});
