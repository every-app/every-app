import { describe, expect, it } from "vitest";
import { FakeCf } from "./fakeCf";
import { hasWorkersPaid } from "./plan";

const subscriptions = (body: unknown) =>
  new FakeCf().on(["accounts", "subscriptions", "get"], {
    stdout: JSON.stringify(body),
  });

describe("hasWorkersPaid", () => {
  it("finds a live Workers Paid subscription", async () => {
    await expect(
      hasWorkersPaid(
        subscriptions([
          { state: "Paid", rate_plan: { id: "zone_pro" } },
          { state: "Paid", rate_plan: { id: "workers_paid", public_name: "Workers Paid" } },
        ]),
      ),
    ).resolves.toBe(true);
    await expect(
      hasWorkersPaid(subscriptions([{ product: { name: "Workers Standard" } }])),
    ).resolves.toBe(true);
  });

  it("can't tell on Free, after a cancellation, or when the answer is unreadable", async () => {
    await expect(hasWorkersPaid(subscriptions([]))).resolves.toBeNull();
    await expect(
      hasWorkersPaid(
        subscriptions([{ state: "Cancelled", rate_plan: { public_name: "Workers Paid" } }]),
      ),
    ).resolves.toBeNull();
    await expect(hasWorkersPaid(subscriptions({ unexpected: true }))).resolves.toBeNull();
    await expect(
      hasWorkersPaid(
        new FakeCf().on(["accounts"], {
          exitCode: 1,
          stderr: "┌ Error\n│ Authentication error [code: 10000]\n└\n",
        }),
      ),
    ).resolves.toBeNull();
  });
});
