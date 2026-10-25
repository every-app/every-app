import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { everyAppWorker } from "@every-app/sdk/cloudflare";
import { getIdentityFromRequest } from "@every-app/sdk/internal";
import { FakeCf } from "@/lib/cf/fakeCf";
import type { CfProcess, CfStartCall } from "@/lib/cf/runner";
import { EveryAppError } from "@/lib/errors";
import { createNdjsonSink, type EventSink } from "@/lib/output/events";
import { getFreePort } from "./proxy";
import { handleInterrupt } from "@/lib/interrupt";
import { runDev } from "./index";
import { devVarsHint, emailHint } from "./ready";

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
  /** What reached the app: method, path and body. */
  readonly requests: Array<{ method: string; url: string; body: string }> = [];

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
      const request = { method: req.method ?? "", url: req.url ?? "", body: "" };
      this.requests.push(request);
      req.on("data", (chunk: Buffer) => (request.body += chunk.toString()));
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(name, value);
      }
      getIdentityFromRequest(
        new Request(`http://${req.headers.host}${req.url}`, { headers }),
        { audience: manifest.id, env },
      ).then(
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

  /** The app stops answering while its dev server runs on. */
  closeApp(): void {
    this.app?.close();
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
      events.find((event) => event["step"] === "dev.app" && event["status"] === "ok"),
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

  it("says what .dev.vars should hold for the app's keys when there is none yet", async () => {
    await fs.writeFile(
      path.join(cwd, "everyapp.config.ts"),
      `export default ${JSON.stringify({ ...manifest, providers: ["openrouter"], secrets: ["MAIN_SECRET"] })};\n`,
    );
    const cf = new DevCf(cwd);
    const port = await getFreePort();
    const running = runDev({ port, "skip-migrations": true }, out, { cwd, cf });

    const ready = await until(() =>
      events.find((event) => event["step"] === "dev.app" && event["status"] === "ok"),
    );
    expect(String(ready["message"])).toContain(
      "no .dev.vars yet: add OPENROUTER_API_KEY, MAIN_SECRET",
    );

    cf.exitApp();
    await running;
  });

  describe("the .dev.vars hint", () => {
    const keyed = {
      id: "todo",
      secrets: ["MAIN_SECRET"],
      providers: ["workers-ai"],
      capabilities: { dataforseo: { access: "read" } },
    } as const;
    const lines = (facts: ReadonlyArray<{ label: string; value: string }>) =>
      facts.map((fact) => `${fact.label}  ${stripVTControlCharacters(fact.value)}`);

    it("names what the file leaves unset, an empty value included, and never a value", async () => {
      await fs.writeFile(
        path.join(cwd, ".dev.vars"),
        "WORKERS_AI_API_TOKEN=tok-1234\nDATAFORSEO_API_KEY=\n# MAIN_SECRET=commented-out\n",
      );
      const facts = devVarsHint(keyed, cwd);
      expect(lines(facts)).toEqual([
        "Dev vars  .dev.vars is missing CLOUDFLARE_ACCOUNT_ID, DATAFORSEO_API_KEY, MAIN_SECRET  (the app's keys for local runs; see pnpm everyapp dev --help)",
      ]);
      expect(facts[0]!.value).not.toContain("tok-1234");
    });

    it("says to add them all when there is no file", () => {
      expect(lines(devVarsHint(keyed, cwd))).toEqual([
        "Dev vars  no .dev.vars yet: add WORKERS_AI_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, DATAFORSEO_API_KEY, MAIN_SECRET  (the app's keys for local runs; see pnpm everyapp dev --help)",
      ]);
    });

    it("says nothing when the file sets every name, or the app needs none", async () => {
      expect(devVarsHint({}, cwd)).toEqual([]);
      await fs.writeFile(
        path.join(cwd, ".dev.vars"),
        "WORKERS_AI_API_TOKEN=t\nCLOUDFLARE_ACCOUNT_ID=a\nDATAFORSEO_API_KEY=d\nMAIN_SECRET=s\n",
      );
      expect(devVarsHint(keyed, cwd)).toEqual([]);
    });

    it("leaves out what the app runs without: email's settings, an instance with a default", async () => {
      // sendEmail() prints with nothing set, and listMembers() answers
      // from the dev identity: no file, no hint.
      const mailer = {
        id: "inbox",
        capabilities: { email: { access: "write" }, members: { access: "read" } },
      } as const;
      expect(devVarsHint(mailer, cwd)).toEqual([]);
      // A working Cloudflare REST setup, EMAIL_FROM_NAME and Resend's unset.
      await fs.writeFile(
        path.join(cwd, ".dev.vars"),
        "EMAIL_FROM=noreply@example.com\nEMAIL_REST_API_TOKEN=t\nCLOUDFLARE_ACCOUNT_ID=a\n",
      );
      expect(devVarsHint(mailer, cwd)).toEqual([]);

      // Mastodon's client, on the default instance.
      const poster = { id: "postiz", capabilities: { mastodon: { access: "write" } } } as const;
      await fs.writeFile(
        path.join(cwd, ".dev.vars"),
        "MASTODON_CLIENT_ID=id\nMASTODON_CLIENT_SECRET=secret\n",
      );
      expect(devVarsHint(poster, cwd)).toEqual([]);
      // Its secret alone is named, never the instance.
      await fs.writeFile(path.join(cwd, ".dev.vars"), "MASTODON_CLIENT_ID=id\n");
      expect(lines(devVarsHint(poster, cwd))).toEqual([
        "Dev vars  .dev.vars is missing MASTODON_CLIENT_SECRET  (the app's keys for local runs; see pnpm everyapp dev --help)",
      ]);
    });

    it("asks for one of an any-of group until a member is set", async () => {
      // The app picks between the two at run time: either opens it.
      const chooser = {
        id: "writer",
        providers: [
          { id: "openrouter", anyOf: "AI model" },
          { id: "workers-ai", anyOf: "AI model" },
        ],
        secrets: ["MAIN_SECRET"],
      } as const;
      expect(lines(devVarsHint(chooser, cwd))).toEqual([
        "Dev vars  no .dev.vars yet: add MAIN_SECRET and one of OPENROUTER_API_KEY, WORKERS_AI_API_TOKEN with CLOUDFLARE_ACCOUNT_ID  (the app's keys for local runs; see pnpm everyapp dev --help)",
      ]);
      // Workers AI's token alone is no member set: its URL needs the account too.
      await fs.writeFile(path.join(cwd, ".dev.vars"), "MAIN_SECRET=s\nWORKERS_AI_API_TOKEN=t\n");
      expect(lines(devVarsHint(chooser, cwd))).toEqual([
        "Dev vars  .dev.vars is missing one of OPENROUTER_API_KEY, WORKERS_AI_API_TOKEN with CLOUDFLARE_ACCOUNT_ID  (the app's keys for local runs; see pnpm everyapp dev --help)",
      ]);
      await fs.writeFile(path.join(cwd, ".dev.vars"), "MAIN_SECRET=s\nOPENROUTER_API_KEY=k\n");
      expect(devVarsHint(chooser, cwd)).toEqual([]);
    });

    it("never names an optional setting", async () => {
      // The app opens without them; the feature says what is missing where it is used.
      const tokened = {
        id: "todo",
        providers: [{ id: "openai", optional: true }],
        secrets: ["MAIN_SECRET", { name: "GITHUB_TOKEN", optional: true }],
      } as const;
      expect(lines(devVarsHint(tokened, cwd))).toEqual([
        "Dev vars  no .dev.vars yet: add MAIN_SECRET  (the app's keys for local runs; see pnpm everyapp dev --help)",
      ]);
      await fs.writeFile(path.join(cwd, ".dev.vars"), "MAIN_SECRET=s\n");
      expect(devVarsHint(tokened, cwd)).toEqual([]);
    });

    it("names a required secret whether it is listed by name or as an entry", async () => {
      const signer = {
        id: "todo",
        secrets: [{ name: "MAIN_SECRET", why: "Signs sessions." }, "WEBHOOK_SECRET"],
      } as const;
      expect(lines(devVarsHint(signer, cwd))).toEqual([
        "Dev vars  no .dev.vars yet: add MAIN_SECRET, WEBHOOK_SECRET  (the app's keys for local runs; see pnpm everyapp dev --help)",
      ]);
      await fs.writeFile(path.join(cwd, ".dev.vars"), "MAIN_SECRET=s\nWEBHOOK_SECRET=\n");
      expect(lines(devVarsHint(signer, cwd))).toEqual([
        "Dev vars  .dev.vars is missing WEBHOOK_SECRET  (the app's keys for local runs; see pnpm everyapp dev --help)",
      ]);
    });
  });

  it("runs with a capability outside the catalog, warning that the deploy checks it and how to reach it locally", async () => {
    const stripe = {
      id: "stripe",
      name: "Stripe",
      docs: "https://dashboard.stripe.com/apikeys",
      hosts: ["api.stripe.com"],
      auth: { kind: "bearer", secret: "STRIPE_API_KEY" },
    };
    await fs.writeFile(
      path.join(cwd, "everyapp.config.ts"),
      `export default ${JSON.stringify({ ...manifest, capabilities: { stripe: { access: "read" }, dataforseo: { access: "read" } } })};\n`,
    );
    // The run stops right after (no cloudflare.config.ts): the warning comes first.
    await fs.rm(path.join(cwd, "cloudflare.config.ts"));
    const cf = new DevCf(cwd);
    const warnings = () => events.filter((event) => event["code"] === "CAPABILITY_NOT_IN_CATALOG");

    await expect(runDev({}, out, { cwd, cf })).rejects.toMatchObject({ code: "MISSING_CLOUDFLARE_CONFIG" });
    expect(warnings()).toEqual([
      expect.objectContaining({
        type: "warning",
        message:
          "stripe isn't in the built-in provider catalog\nIf it's registered on your Gateway, pnpm everyapp provider show stripe --save writes .everyapp/providers/stripe.json, which this run reaches it from (start dev again after). The deploy checks it against the Gateway's registered providers.",
        data: {
          id: "stripe",
          file: ".everyapp/providers/stripe.json",
          found: false,
          fix: "pnpm everyapp provider show stripe --save",
        },
      }),
    ]);

    // With the spec there, the run reaches it, and .dev.vars wants its key.
    await fs.mkdir(path.join(cwd, ".everyapp", "providers"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".everyapp", "providers", "stripe.json"), JSON.stringify(stripe));
    events = [];
    await expect(runDev({}, out, { cwd, cf })).rejects.toMatchObject({ code: "MISSING_CLOUDFLARE_CONFIG" });
    expect(warnings()).toEqual([
      expect.objectContaining({
        message:
          "stripe isn't in the built-in provider catalog\nThis run reaches it from .everyapp/providers/stripe.json with your key from .dev.vars; the deploy checks it against the Gateway's registered providers.",
        data: { id: "stripe", file: ".everyapp/providers/stripe.json", found: true },
      }),
    ]);
    expect(
      devVarsHint({ capabilities: { stripe: { access: "read" } } }, cwd).map((fact) => stripVTControlCharacters(fact.value)),
    ).toEqual([
      "no .dev.vars yet: add STRIPE_API_KEY  (the app's keys for local runs; see pnpm everyapp dev --help)",
    ]);
    expect(cf.started).toEqual([]);
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

  it("says where to run it outside an app, and what an app without cloudflare.config.ts needs", async () => {
    const cf = new DevCf(cwd);
    await fs.rm(path.join(cwd, "cloudflare.config.ts"));
    await expect(runDev({}, out, { cwd, cf })).rejects.toMatchObject({
      code: "MISSING_CLOUDFLARE_CONFIG",
      data: { fix: "copy cloudflare.config.ts from starter/" },
    });
    await fs.rm(path.join(cwd, "everyapp.config.ts"));
    // The same error every other command raises for a missing manifest.
    await expect(runDev({}, out, { cwd, cf })).rejects.toMatchObject({
      code: "MANIFEST_NOT_FOUND",
      message: "No everyapp.config.ts in this directory",
      fix: "run this from the app's directory",
    });
    expect(cf.started).toEqual([]);
  });

  it("refuses a Gateway port in use before anything starts, suggesting the next free one", async () => {
    const taken = http.createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    const port = (taken.address() as { port: number }).port;
    const cf = new DevCf(cwd);
    try {
      const error = (await runDev({ port }, out, { cwd, cf }).catch(
        (thrown: unknown) => thrown,
      )) as EveryAppError;
      const free = Number(error.data?.["free"]);
      expect(free).toBeGreaterThan(port);
      expect(error).toMatchObject({
        code: "DEV_PORT_IN_USE",
        message: `Port ${port} is already in use`,
        rerun: expect.stringMatching(new RegExp(`^pnpm everyapp.* --port ${free}$`)),
      });
    } finally {
      taken.close();
    }
    expect(cf.calls).toEqual([]);
    expect(cf.started).toEqual([]);
  });

  it("runs a cron through the gateway-lite, and shows how when the app declares crons", async () => {
    await fs.writeFile(
      path.join(cwd, "cloudflare.config.ts"),
      "// worker: everyAppWorker({ manifest, entrypoint, ctx, crons: ['*/5 * * * *'] })\n",
    );
    const cf = new DevCf(cwd);
    const port = await getFreePort();
    const running = runDev({ port, "skip-migrations": true }, out, { cwd, cf });

    const ready = await until(() =>
      events.find((event) => event["step"] === "dev.app" && event["status"] === "ok"),
    );
    expect(String(ready["message"])).toContain(
      `curl -X POST http://todo.localhost:${port}/__everyapp/cron -d '<schedule>'`,
    );

    await new Promise<void>((resolve, reject) => {
      http
        .request(
          {
            host: "127.0.0.1",
            port,
            method: "POST",
            path: "/__everyapp/cron",
            headers: { host: `todo.localhost:${port}` },
          },
          (res) => res.resume().on("end", resolve),
        )
        .on("error", reject)
        .end("*/5 * * * *");
    });
    expect(cf.requests).toContainEqual({
      method: "POST",
      url: "/cdn-cgi/local/explorer/api/local/scheduled?worker=every-todo",
      body: JSON.stringify({ cron: "*/5 * * * *" }),
    });

    cf.exitApp();
    await running;
  });

  it("refuses another app's host with 421, warning once", async () => {
    const cf = new DevCf(cwd);
    const port = await getFreePort();
    const running = runDev({ port, "skip-migrations": true }, out, { cwd, cf });
    await until(() => events.find((event) => event["step"] === "dev.ready"));

    for (let i = 0; i < 2; i++) {
      expect(await get(port, `other.localhost:${port}`)).toEqual({
        status: 421,
        body: `This dev server serves todo.localhost, not other.localhost:${port}.\n`,
      });
    }
    expect(events.filter((event) => event["type"] === "warning")).toEqual([
      expect.objectContaining({
        code: "DEV_WRONG_HOST",
        message: `Request for other.localhost:${port} refused: this dev server serves todo.localhost`,
      }),
    ]);

    cf.exitApp();
    await running;
  });

  it("warns once when requests fail in the gateway-lite", async () => {
    const cf = new DevCf(cwd);
    const port = await getFreePort();
    const running = runDev({ port, "skip-migrations": true }, out, { cwd, cf });
    await until(() => events.find((event) => event["step"] === "dev.ready"));
    cf.closeApp();

    for (const _ of [1, 2]) {
      expect((await get(port, `todo.localhost:${port}`)).status).toBe(502);
    }
    const warnings = events.filter((event) => event["type"] === "warning");
    expect(warnings).toEqual([
      expect.objectContaining({
        code: "DEV_REQUEST_FAILED",
        message: expect.stringMatching(/^GET \/ failed in the local Gateway: connect ECONNREFUSED/),
      }),
    ]);

    cf.exitApp();
    await running;
  });

  it("stops the app on Ctrl+C, says so, and exits 130", async () => {
    const cf = new DevCf(cwd);
    const port = await getFreePort();
    const running = runDev({ port, "skip-migrations": true }, out, { cwd, cf });
    await until(() => events.find((event) => event["step"] === "dev.ready"));

    const exits: number[] = [];
    await handleInterrupt("SIGINT", { exit: (code) => exits.push(code) });
    await running;

    expect(exits).toEqual([130]);
    expect(events.at(-1)).toMatchObject({
      type: "step",
      step: "dev.stop",
      status: "ok",
      data: { appId: "todo", started: true },
    });
  });

  it("replays what the app's dev server printed when it exits before it is ready", async () => {
    // A dev server that exits at once.
    const cf = new (class extends FakeCf {
      released: boolean[] = [];
      override async start(call: CfStartCall): Promise<CfProcess> {
        const child = await super.start(call);
        child.stop();
        return { ...child, releaseOutput: (startup) => this.released.push(startup) };
      }
    })();
    const port = await getFreePort();

    await expect(
      runDev({ port, "skip-migrations": true }, out, { cwd, cf }),
    ).rejects.toMatchObject({
      code: "DEV_SERVER_FAILED",
      message: "todo's dev server exited before it was ready\nIts output is above.",
    });
    expect(cf.released).toEqual([true]);
    expect(events.at(-1)).toMatchObject({ step: "dev.app", status: "fail" });
  });
});
