import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeCf } from "@/lib/cf/fakeCf";
import { generateWorkerTypes, hasWorkerTypes, WORKER_TYPES_FILE } from "./workerTypes";

let cwd: string;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "everyapp-worker-types-"));
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

describe("worker types", () => {
  it("runs cf workers types in the app", async () => {
    const cf = new FakeCf();
    await generateWorkerTypes(cf, cwd);
    expect(cf.calls).toMatchObject([
      { args: ["workers", "types"], plane: "project", cwd },
    ]);
  });

  it("knows whether the types exist", async () => {
    expect(await hasWorkerTypes(cwd)).toBe(false);
    await fs.mkdir(path.dirname(path.join(cwd, WORKER_TYPES_FILE)), {
      recursive: true,
    });
    await fs.writeFile(path.join(cwd, WORKER_TYPES_FILE), "");
    expect(await hasWorkerTypes(cwd)).toBe(true);
  });
});
