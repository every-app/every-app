import { describe, expect, it } from "vitest";
import { FakeCf } from "./fakeCf";
import {
  deleteD1,
  deleteKv,
  findKv,
  getOrCreateD1,
  getOrCreateKv,
} from "./resources";
import { deleteWorker } from "./workers";

const box = (message: string) => `┌ Error\n│ ${message}\n└\n`;

describe("getOrCreateD1", () => {
  it("finds a database by its exact name only", async () => {
    const cf = new FakeCf()
      .on(["d1", "list"], {
        stdout: JSON.stringify([
          { uuid: "id-1", name: "every-acme-todo-staging" },
          { uuid: "id-2", name: "every-acme-todo" },
        ]),
      });
    await expect(getOrCreateD1(cf, "every-acme-todo")).resolves.toEqual({
      id: "id-2",
      created: false,
    });
  });

  it("reads the winner's database when a concurrent create took the name", async () => {
    let listed = 0;
    const cf = new FakeCf()
      .on(["d1", "list"], () => ({
        stdout:
          (listed += 1) === 1
            ? "[]"
            : JSON.stringify([{ uuid: "id-9", name: "every-acme-todo" }]),
      }))
      .on(["d1", "create"], {
        exitCode: 1,
        stderr: box("A database with that name already exists [code: 7502]"),
      });

    await expect(getOrCreateD1(cf, "every-acme-todo")).resolves.toEqual({
      id: "id-9",
      created: false,
    });
  });
});

describe("KV namespaces", () => {
  it("pages through namespaces to find a title", async () => {
    const page = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `id-${i}`, title: `ns-${i}` }));
    const cf = new FakeCf().on(["kv", "namespaces", "list"], (call) => ({
      stdout: JSON.stringify(
        call.args.at(-1) === "1"
          ? page(100)
          : [{ id: "target", title: "every-app-gateway-deploy" }],
      ),
    }));

    await expect(findKv(cf, "every-app-gateway-deploy")).resolves.toBe("target");
    expect(cf.calls.map((call) => call.args.slice(-4))).toEqual([
      ["--per-page", "100", "--page", "1"],
      ["--per-page", "100", "--page", "2"],
    ]);
  });

  it("creates a namespace that doesn't exist", async () => {
    const cf = new FakeCf()
      .on(["kv", "namespaces", "list"], { stdout: "[]" })
      .on(["kv", "namespaces", "create"], {
        stdout: JSON.stringify({ id: "new", title: "every-acme-todo" }),
      });
    await expect(getOrCreateKv(cf, "every-acme-todo")).resolves.toEqual({
      id: "new",
      created: true,
    });
    expect(cf.calls.at(-1)!.args).toEqual([
      "kv",
      "namespaces",
      "create",
      "--title",
      "every-acme-todo",
    ]);
  });
});

describe("deleting", () => {
  // cf without --force and a terminal: it declines, says so, exits 0.
  const declines = (args: string[]) =>
    args.includes("--force")
      ? { stdout: "{}" }
      : { stderr: "? This permanently deletes the resource. Continue?\nAborted.\n" };

  it("confirms cf's question for the database, namespace or Worker it was asked to delete", async () => {
    const cf = new FakeCf().on(() => true, (call) => declines(call.args));

    await deleteD1(cf, "db-1");
    await deleteKv(cf, "ns-1");
    await deleteWorker(cf, "every-acme-todo");

    expect(cf.calls.map((call) => call.args)).toEqual([
      ["d1", "delete", "db-1", "--force"],
      ["kv", "namespaces", "delete", "ns-1", "--force"],
      ["workers", "delete", "every-acme-todo", "--force"],
    ]);
  });

  it("fails when cf says Aborted. instead of deleting", async () => {
    const cf = new FakeCf().on(() => true, { stderr: "Aborted.\n" });

    await expect(deleteD1(cf, "db-1")).rejects.toMatchObject({
      name: "CfError",
      kind: "aborted",
    });
  });
});
