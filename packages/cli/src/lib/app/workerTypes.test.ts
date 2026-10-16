import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeCf } from "@/lib/cf/fakeCf";
import { ensureWorkerTypes, WORKER_TYPES_FILE } from "./workerTypes";

let cwd: string;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "everyapp-worker-types-"));
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

describe("ensureWorkerTypes", () => {
  it("runs cf workers types in the app when the types are missing", async () => {
    const cf = new FakeCf();
    expect(await ensureWorkerTypes(cf, cwd)).toBe(true);
    expect(cf.calls).toMatchObject([
      { args: ["workers", "types"], plane: "project", cwd },
    ]);
  });

  it("leaves existing types alone", async () => {
    await fs.mkdir(path.dirname(path.join(cwd, WORKER_TYPES_FILE)), {
      recursive: true,
    });
    await fs.writeFile(path.join(cwd, WORKER_TYPES_FILE), "");
    const cf = new FakeCf();
    expect(await ensureWorkerTypes(cf, cwd)).toBe(false);
    expect(cf.calls).toEqual([]);
  });
});
