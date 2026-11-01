import { describe, expect, it } from "vitest";
import { FakeCf } from "./fakeCf";
import { WorkersPlan, workersPlan } from "./plan";

const subscriptions = (body: unknown) =>
  new FakeCf().on(["accounts", "subscriptions", "get"], {
    stdout: JSON.stringify(body),
  });

describe("workersPlan", () => {
  it("finds a live Workers Paid subscription", async () => {
    await expect(
      workersPlan(
        subscriptions([
          { state: "Paid", rate_plan: { id: "zone_pro" } },
          { state: "Paid", rate_plan: { id: "workers_paid", public_name: "Workers Paid" } },
        ]),
      ),
    ).resolves.toBe(WorkersPlan.Paid);
    await expect(
      workersPlan(subscriptions([{ product: { name: "Workers Standard" } }])),
    ).resolves.toBe(WorkersPlan.Paid);
  });

  it("reads Free only when a subscription names it", async () => {
    await expect(
      workersPlan(subscriptions([{ state: "Paid", rate_plan: { id: "workers_free", public_name: "Workers Free" } }])),
    ).resolves.toBe(WorkersPlan.Free);
  });

  it("can't tell with no Workers subscription, or after a cancellation", async () => {
    await expect(workersPlan(subscriptions([]))).resolves.toBe(WorkersPlan.Unknown);
    await expect(
      workersPlan(
        subscriptions([{ state: "Cancelled", rate_plan: { public_name: "Workers Paid" } }]),
      ),
    ).resolves.toBe(WorkersPlan.Unknown);
  });

  it("says so when the answer is unreadable", async () => {
    await expect(workersPlan(subscriptions({ unexpected: true }))).resolves.toBe(
      WorkersPlan.Unreadable,
    );
    await expect(
      workersPlan(
        new FakeCf().on(["accounts"], {
          exitCode: 1,
          stderr: "┌ Error\n│ Authentication error [code: 10000]\n└\n",
        }),
      ),
    ).resolves.toBe(WorkersPlan.Unreadable);
  });
});
