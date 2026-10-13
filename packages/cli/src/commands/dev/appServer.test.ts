import path from "node:path";
import { describe, expect, it } from "vitest";
import { FakeCf } from "@/lib/cf/fakeCf";
import { startAppDevServer } from "./appServer";

describe("startAppDevServer", () => {
  it("runs cf dev on the internal port with this checkout's dev registry", async () => {
    const cf = new FakeCf();
    const server = await startAppDevServer({
      cwd: "/work/todo",
      manifest: { id: "todo" },
      cf,
      port: 41234,
    });

    expect(cf.started).toEqual([
      {
        args: ["dev"],
        cwd: "/work/todo",
        env: {
          PORT: "41234",
          CLOUDFLARE_REGISTRY_PATH: path.join(
            "/work/todo",
            ".everyapp",
            "registry",
          ),
          MINIFLARE_REGISTRY_PATH: path.join(
            "/work/todo",
            ".everyapp",
            "registry",
          ),
        },
      },
    ]);

    server.stop();
    await expect(server.exited).resolves.toMatchObject({ signal: "SIGTERM" });
  });
});
