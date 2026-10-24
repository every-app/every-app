import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeCf } from "@/lib/cf/fakeCf";
import { startAppDevServer } from "./appServer";

afterEach(() => {
  vi.unstubAllEnvs();
});

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
        holdOutput: true,
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

  it.runIf(process.platform !== "win32")(
    "runs the manifest's dev command with the build's NODE_OPTIONS, after the person's own",
    async () => {
      // A TanStack Start dev server resolves localhost like a build's
      // prerender (lib/runtime.ts, buildNodeOptions).
      vi.stubEnv("NODE_OPTIONS", "--max-old-space-size=4096");
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "everyapp-dev-app-"));
      const file = path.join(dir, "env.json");
      try {
        const server = await startAppDevServer({
          cwd: dir,
          manifest: {
            id: "todo",
            dev: `node -e "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ port: process.env.PORT, nodeOptions: process.env.NODE_OPTIONS }))" ${file}`,
          },
          cf: new FakeCf(),
          port: 41235,
        });
        await expect(server.exited).resolves.toMatchObject({ code: 0 });
        expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
          port: "41235",
          nodeOptions: "--max-old-space-size=4096 --dns-result-order=ipv4first",
        });
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );
});
