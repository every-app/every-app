import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { everyAppWorker } from "@every-app/sdk/cloudflare";
import { getIdentityFromRequest } from "@every-app/sdk/internal";
import { FakeCf } from "@/lib/cf/fakeCf";
import type { CfProcess, CfStartCall } from "@/lib/cf/runner";
import { EveryAppError } from "@/lib/errors";
import { createNdjsonSink, type EventSink } from "@/lib/output/events";
import { getFreePort } from "./proxy";
import { emailHint, runDev } from "./index";

const manifest = {
  id: "todo",
  name: "Todos",
  resources: { d1: ["DB"] },
  public: [],
} as const;

/**
 * `cf dev` stand-in: an app on the PORT it is given that verifies the
 * identity header exactly as the dev Worker would, with the env
 * everyAppWorker() gives it in development.
 */
class DevCf extends FakeCf {
  private app?: http.Server;
  private stopApp?: () => void;

  constructor(private readonly cwd: string) {
    super();
    this.on(["d1", "migrations", "apply"], { stdout: "[]" });
  }

  override async start(call: CfStartCall): Promise<CfProcess> {
    const child = await super.start(call);
    const bindings = everyAppWorker({
      manifest,
      entrypoint: {},
      ctx: { mode: "development" },
      root: this.cwd,
    }).env as Record<string, { type: string; value?: string }>;
    const env = Object.fromEntries(
      Object.entries(bindings).flatMap(([name, binding]) =>
        binding.type === "text" ? [[name, binding.value]] : [],
      ),
    );
    this.app = http.createServer((req, res) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(name, value);
      }
      const request = new Request(`http://${req.headers.host}${req.url}`, {
        headers,
      });
      getIdentityFromRequest(request, { audience: manifest.id, env }).then(
        ({ user }) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ email: user?.email }));
        },
        (error: Error) => {
          res.writeHead(401);
          res.end(error.message);
        },
      );
    });
    await new Promise<void>((resolve) =>
      this.app!.listen(Number(call.env?.["PORT"]), "127.0.0.1", resolve),
    );
    const stop = (signal?: NodeJS.Signals) => {
      this.app?.close();
      child.stop(signal);
    };
    this.stopApp = stop;
    return { ...child, stop };
  }

  /** The app's dev server exits (what Ctrl-C ends in). */
  exitApp(): void {
    this.stopApp?.();
  }
}

let cwd: string;
let events: Array<Record<string, unknown>>;
let out: EventSink;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "everyapp-dev-"));
  await fs.writeFile(
    path.join(cwd, "everyapp.config.ts"),
    `export default ${JSON.stringify(manifest)};\n`,
  );
  await fs.writeFile(
    path.join(cwd, "cloudflare.config.ts"),
    "// worker: everyAppWorker({ manifest, entrypoint, ctx })\n",
  );
  await fs.mkdir(path.join(cwd, "drizzle"));
  events = [];
  out = createNdjsonSink((line) => events.push(JSON.parse(line)));
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

async function until<T>(find: () => T | undefined): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const found = find();
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out; events: ${JSON.stringify(events)}`);
}

function get(
  port: number,
  host: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: "/", headers: { host } }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

describe("everyapp dev", () => {
  it("serves the app on loopback with an identity the dev Worker trusts, writing nothing into the app", async () => {
    const cf = new DevCf(cwd);
    const port = await getFreePort();
    const listeners = process.listenerCount("SIGINT");
    const running = runDev({ port }, out, { cwd, cf });

    const ready = await until(() =>
      events.find((event) => event["step"] === "dev.ready"),
    );
    expect(ready).toMatchObject({
      status: "ok",
      data: {
        host: "127.0.0.1",
        port,
        appUrl: `http://todo.localhost:${port}`,
      },
    });

    const response = await get(port, `todo.localhost:${port}`);
    expect(response).toEqual({
      status: 200,
      body: JSON.stringify({ email: "dev@everyapp.localhost" }),
    });

    // A fresh clone: the Worker's types, then the local migrations.
    expect(cf.calls.map((call) => call.args.slice(0, 3))).toEqual([
      ["workers", "types"],
      ["d1", "migrations", "apply"],
    ]);

    // dev returns once the app's dev server has exited, and lets go of
    // the signals it stopped the server on.
    expect(process.listenerCount("SIGINT")).toBe(listeners + 1);
    cf.exitApp();
    await running;
    expect(process.listenerCount("SIGINT")).toBe(listeners);

    const entries = await fs.readdir(cwd);
    expect(entries.sort()).toEqual([
      "cloudflare.config.ts",
      "drizzle",
      "everyapp.config.ts",
    ]);
  });

  it("leaves existing Worker types alone", async () => {
    await fs.mkdir(path.join(cwd, ".cloudflare", "types"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, ".cloudflare", "types", "index.d.ts"),
      "",
    );
    const cf = new DevCf(cwd);
    const port = await getFreePort();
    const running = runDev({ port, "skip-migrations": true }, out, { cwd, cf });

    await until(() => events.find((event) => event["step"] === "dev.ready"));
    expect(cf.calls).toEqual([]);

    cf.exitApp();
    await running;
  });

  it("prints how to deliver mail to the app's email() handler, on the app's own dev server", async () => {
    await fs.writeFile(
      path.join(cwd, "everyapp.config.ts"),
      `export default ${JSON.stringify({ ...manifest, email: { inbound: true } })};\n`,
    );
    const cf = new DevCf(cwd);
    const port = await getFreePort();
    const running = runDev({ port, "skip-migrations": true }, out, { cwd, cf });

    const ready = await until(() =>
      events.find((event) => event["step"] === "dev.ready"),
    );
    const appPort = Number(cf.started[0]!.env?.["PORT"]);
    expect(String(ready["message"])).toContain(
      `curl -X POST "http://127.0.0.1:${appPort}/cdn-cgi/local/email?from=someone@example.net&to=hello@example.com" --data-binary @message.eml`,
    );

    cf.exitApp();
    await running;
  });

  it("prints no mail hint for an app that receives none", () => {
    expect(emailHint({}, 5173)).toEqual([]);
    expect(emailHint({ email: { inbound: false } }, 5173)).toEqual([]);
    expect(emailHint({ email: { inbound: true } }, 5173)[0]?.value).toContain("to=hello@example.com");
  });

  it("refuses an unknown mode before starting anything", async () => {
    const cf = new DevCf(cwd);
    await expect(
      runDev({ mode: "prod" }, out, { cwd, cf }),
    ).rejects.toMatchObject({ code: "INVALID_DEV_MODE" });
    await expect(
      runDev({ mode: "prod" }, out, { cwd, cf }),
    ).rejects.toBeInstanceOf(EveryAppError);
    expect(cf.started).toEqual([]);
  });
});
