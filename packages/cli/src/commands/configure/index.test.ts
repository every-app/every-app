/**
 * `everyapp configure [app]` end to end, in a fake Cloudflare account with
 * a deployed gateway and apps (as secret/index.test.ts): the prompts a
 * person answers (required settings, then which member of an any-of
 * group, then the optional ones), the menu when everything is set, the
 * sources a script uses (NAME=value lines on stdin, --from-env), what is
 * refused before anything is written, and what the run says at the end.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cfD1Database } from "@/lib/cf/d1";
import { CancelledError } from "@/lib/errors";
import { applyGateway } from "@/lib/gateway/apply";
import { readInstall } from "@/lib/gateway/install";
import { addProvider } from "@/lib/gateway/providers";
import { readApp } from "@/lib/gateway/registry";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import type { EveryAppCliManifest } from "@/lib/manifest";
import { createNdjsonSink } from "@/lib/output/events";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { buildGatewayRelease, releaseSource } from "@/test/gatewayRelease";
import { GatewayWorker } from "@/test/gatewayWorker";
import { makeTestHome } from "@/test/home";
import { deployApp } from "../deploy/deployApp";
import { configureApp, type Prompter } from "./index";

const GATEWAY = "every-app-gateway";

/**
 * An app that says what each setting is for: an AI provider, a capability
 * and a secret of its own it can't open without, and two optional
 * features: one of a Gateway capability alone, one of a secret.
 */
const CRM: EveryAppCliManifest = {
  id: "crm",
  resources: { d1: ["DB"] },
  providers: [{ id: "openrouter", why: "Any model through one key." }],
  capabilities: {
    dataforseo: { access: "read", why: "Keyword data for research." },
    context: { access: "read", why: "Renders JavaScript pages in audits." },
    email: { access: "write" },
  },
  secrets: [{ name: "TOKEN_ENCRYPTION_KEY", why: "Encrypts the OAuth tokens it stores." }],
  features: {
    rendering: { name: "Rendering", why: "Audits of JavaScript sites.", capabilities: ["context"] },
    mail: { name: "Mail", why: "Sends reports.", capabilities: ["email"] },
    github: {
      name: "GitHub",
      why: "Raises the GitHub rate limit.",
      secrets: [{ name: "GITHUB_TOKEN", how: "A fine-grained token with no permissions" }],
    },
  },
};

/** An app with nothing to set. */
const NOTES: EveryAppCliManifest = { id: "notes", resources: { d1: ["DB"] } };

let account: FakeCloudflare;
let worker: GatewayWorker;
let tarball: string;
let release: GatewayRelease;
let home: string;
let events: Array<Record<string, any>>;
const dirs: string[] = [];

const out = () => createNdjsonSink((line) => events.push(JSON.parse(line)));
const flags = { json: true };
const seams = { sleep: async () => undefined, leaseWaitMs: 0 };
const db = () =>
  cfD1Database(
    account.cf,
    [...account.databases].find(([, entry]) => entry.name === GATEWAY)![0],
  );
const gateway = () => account.workers.get(GATEWAY)!;
const done = () => events.find((event) => event["type"] === "done");
const warnings = () => events.filter((event) => event["type"] === "warning");
const createCf = vi.fn(() => account.cf);

beforeEach(async () => {
  events = [];
  home = makeTestHome();
  vi.stubEnv("HOME", home);
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  account = new FakeCloudflare();
  worker = new GatewayWorker(account);
  tarball = await buildGatewayRelease();
  release = await openRelease(tarball);
  const resources = await ensureGatewayResources(account.cf);
  await applyGateway({
    cf: account.cf,
    out: out(),
    reason: "deploy",
    release,
    accountId: ACCOUNT_ID,
    gatewayHost: "example.com",
    zone: { id: "zone-1", name: "example.com" },
    appBaseDomain: "example.com",
    resources,
    db: cfD1Database(account.cf, resources.d1Id),
    interactive: false,
    cliVersion: "0.3.0",
    ...seams,
  });
  events = [];
});

afterEach(async () => {
  await release.cleanup();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A directory with no app in it. */
function emptyDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-configure-none-"));
  dirs.push(dir);
  return dir;
}

/** An app's directory: its real everyapp.config.ts, and what the fake build needs. */
function appDir(manifest: EveryAppCliManifest): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-configure-app-"));
  dirs.push(dir);
  fs.writeFileSync(
    path.join(dir, "everyapp.config.ts"),
    `export default ${JSON.stringify(manifest, null, 2)} as const;\n`,
  );
  fs.writeFileSync(
    path.join(dir, "cloudflare.config.ts"),
    "export default defineConfig((ctx) => ({ worker: everyAppWorker({ manifest, entrypoint, ctx }) }));\n",
  );
  fs.mkdirSync(path.join(dir, "drizzle", "meta"), { recursive: true });
  fs.writeFileSync(path.join(dir, "drizzle", "0000_init.sql"), "CREATE TABLE todos (id text PRIMARY KEY, title text);");
  fs.writeFileSync(
    path.join(dir, "drizzle", "meta", "_journal.json"),
    JSON.stringify({ entries: [{ tag: "0000_init", when: 1000 }] }),
  );
  account.apps.set(dir, manifest);
  return dir;
}

async function deploy(dir: string, manifest: EveryAppCliManifest): Promise<string> {
  await deployApp({
    cwd: dir,
    manifest,
    out: out(),
    createCf: () => account.cf,
    installDeps: async () => undefined,
    reconcile: { ...seams, openRelease: () => openRelease(tarball), source: () => releaseSource(tarball) },
    live: { fetch: worker.fetch, sleep: async () => undefined },
  });
  events = [];
  return (await readApp(db(), manifest.id)).workerName;
}

/** What a scripted person answers, and every question they were asked. */
interface Script {
  /** Each prompt's answer by the setting name asked for (a secret or a plain value). */
  values?: Record<string, string>;
  /** The answer to "Set the optional settings too?" (default No). */
  optional?: boolean;
  /** For each choice prompt in order: the label to pick. */
  picks?: string[];
}

function scripted(
  script: Script,
): Prompter & { asked: string[]; questions: Array<Record<string, unknown>>; told: string[] } {
  const picks = [...(script.picks ?? [])];
  const asked: string[] = [];
  const questions: Array<Record<string, unknown>> = [];
  const told: string[] = [];
  const answer = (question: string) => {
    const name = question.replace(/ \(Enter to skip\)$/, "");
    asked.push(name);
    return script.values?.[name] ?? "";
  };
  return {
    asked,
    questions,
    told,
    secret: async (question, options) => {
      questions.push({ kind: "secret", question, ...options });
      return answer(question);
    },
    text: async (question, options) => {
      questions.push({ kind: "text", question, context: options.context, optional: options.optional });
      const value = answer(question);
      const problem = value ? options.validate(value) : null;
      if (problem) throw new Error(`${question}: ${problem}`);
      return value;
    },
    confirm: async (question, context) => {
      questions.push({ kind: "confirm", question, context });
      return script.optional ?? false;
    },
    choose: async (question, choices) => {
      questions.push({ kind: "choose", question, choices: choices.map((choice) => choice.label) });
      const label = picks.shift();
      const chosen = choices.find((choice) => choice.label === label);
      if (!chosen) throw new Error(`no choice ${label} for "${question}": ${choices.map((choice) => choice.label).join(", ")}`);
      return chosen.value;
    },
  };
}

/** `configure` at a terminal, answering with `script`. */
function configureAt(
  cwd: string,
  script: Script,
  more: { appId?: string; fromEnv?: boolean; env?: Record<string, string> } = {},
) {
  const prompter = scripted(script);
  const run = configureApp({
    flags: { ...flags, ...(more.fromEnv ? { "from-env": true } : {}) },
    out: out(),
    cwd,
    createCf,
    interactive: true,
    prompter,
    appId: more.appId,
    env: more.env ?? {},
    readStdin: async () => null,
    tell: (line) => prompter.told.push(line),
  });
  return Object.assign(run, { prompter });
}

/** `configure --json` from a script: nothing at the terminal; stdin and the environment. */
function configureFrom(
  more: { appId?: string; cwd?: string; stdin?: string; fromEnv?: boolean; env?: Record<string, string> } = {},
) {
  return configureApp({
    flags: { ...flags, ...(more.fromEnv ? { "from-env": true } : {}) },
    out: out(),
    cwd: more.cwd ?? emptyDir(),
    createCf,
    interactive: false,
    appId: more.appId,
    env: more.env ?? {},
    readStdin: async () => more.stdin ?? null,
  });
}

const secretsOf = (workerName: string) => account.workers.get(workerName)!.secrets;

/** The error a run ended with (it must end with one). */
async function failureOf(run: Promise<void>): Promise<Error & { code: string; fix?: string }> {
  try {
    await run;
  } catch (error) {
    return error as Error & { code: string; fix?: string };
  }
  throw new Error("the run succeeded");
}

describe("configure at a terminal", () => {
  it("asks for each required setting, then offers each optional feature, and sets each where it is held", async () => {
    const dir = appDir(CRM);
    const workerName = await deploy(dir, CRM);

    const run = configureAt(dir, {
      values: { DATAFORSEO_API_KEY: "login:password", OPENROUTER_API_KEY: "sk-or", TOKEN_ENCRYPTION_KEY: "tek" },
    });
    await run;

    // One line on where the values go, then the table, before the first prompt.
    expect(run.prompter.told[0]).toMatch(/^crm's settings are held as the Gateway's secrets/);
    // The SETTING column is as wide as the two-name email row.
    expect(run.prompter.told.slice(2, 4)).toEqual([
      "SETTING                     WHERE    STATUS",
      "OPENROUTER_API_KEY          Gateway  ! not set",
    ]);
    // The top level in manifest order; an optional feature's Gateway settings are never asked for.
    expect(run.prompter.asked).toEqual(["OPENROUTER_API_KEY", "DATAFORSEO_API_KEY", "TOKEN_ENCRYPTION_KEY"]);
    // A prompt carries why, what the key is, where to get it and the guide; a hidden prompt for a credential.
    expect(run.prompter.questions[1]).toEqual({
      kind: "secret",
      question: "DATAFORSEO_API_KEY",
      optional: false,
      context: [
        "DataForSEO: Keyword data for research.",
        "The API login and password from API Access, as login:password (or that pair base64-encoded); the Gateway sends them as HTTP Basic. login:password, or its base64; never the dashboard sign-in password.",
        "Get it at https://app.dataforseo.com/api-access",
        "Guide: node_modules/everyapp/skills/everyapp/setup/dataforseo.md",
      ],
    });
    // The one optional feature with a value of the app's own is offered, by name, No by default.
    expect(run.prompter.questions.at(-1)).toEqual({
      kind: "confirm",
      question: "Set up GitHub?",
      context: ["Raises the GitHub rate limit."],
    });

    expect(gateway().secrets).toMatchObject({ DATAFORSEO_API_KEY: "login:password", OPENROUTER_API_KEY: "sk-or" });
    expect(secretsOf(workerName)["TOKEN_ENCRYPTION_KEY"]).toBe("tek");
    expect(secretsOf(workerName)["GITHUB_TOKEN"]).toBeUndefined();
    expect((await readApp(db(), "crm")).secretNames).toEqual(["TOKEN_ENCRYPTION_KEY"]);
    expect(warnings()).toEqual([]);
    // Said in manifest order, whatever order they were typed in.
    expect(done()).toMatchObject({
      message: "Set OPENROUTER_API_KEY, DATAFORSEO_API_KEY and TOKEN_ENCRYPTION_KEY. crm is ready",
      data: {
        app: { id: "crm", deployed: true, setup: expect.objectContaining({ ready: true, command: null }) },
        set: ["OPENROUTER_API_KEY", "DATAFORSEO_API_KEY", "TOKEN_ENCRYPTION_KEY"],
        changed: {
          gateway: { names: ["OPENROUTER_API_KEY", "DATAFORSEO_API_KEY"] },
          app: { id: "crm", workerName, names: ["TOKEN_ENCRYPTION_KEY"] },
        },
      },
    });
    expect(done()!["data"]).not.toHaveProperty("next");
    // The steps a person sees: one per destination, the Gateway's first.
    expect(
      events.filter((event) => event["type"] === "step" && event["status"] === "ok").map((event) => event["message"]),
    ).toEqual(["Set OPENROUTER_API_KEY and DATAFORSEO_API_KEY on the Gateway", "Set TOKEN_ENCRYPTION_KEY on crm"]);
  });

  it("changes any setting from the menu once ready, skipping a name left blank, and checks a plain setting as typed", async () => {
    const dir = appDir(CRM);
    const workerName = await deploy(dir, CRM);
    gateway().secrets["DATAFORSEO_API_KEY"] = "set";
    gateway().secrets["OPENROUTER_API_KEY"] = "set";
    secretsOf(workerName)["TOKEN_ENCRYPTION_KEY"] = "set";

    // Ready already, the GitHub feature declined: the menu. Pick the email
    // sender (two names, one menu entry; the name left blank is skipped),
    // then the GitHub token, then leave.
    const run = configureAt(dir, {
      values: { EMAIL_FROM: "Acme <hello@example.com>", GITHUB_TOKEN: "ghp_x" },
      picks: ["EMAIL_FROM + EMAIL_FROM_NAME", "GITHUB_TOKEN", "No, done"],
    });
    await run;

    expect(run.prompter.questions[0]).toMatchObject({ kind: "confirm", question: "Set up GitHub?" });
    expect(run.prompter.questions[1]).toMatchObject({
      kind: "choose",
      question: "Everything crm needs is set. Change one?",
      choices: ["OPENROUTER_API_KEY", "DATAFORSEO_API_KEY", "CONTEXT_API_KEY", "EMAIL_FROM + EMAIL_FROM_NAME", "TOKEN_ENCRYPTION_KEY", "GITHUB_TOKEN", "No, done"],
    });
    // A plain setting is asked visibly, with what it takes above it.
    expect(run.prompter.questions[2]).toMatchObject({
      kind: "text",
      question: "EMAIL_FROM (Enter to skip)",
      optional: true,
      context: expect.arrayContaining([expect.stringMatching(/^Takes an address/)]),
    });
    expect(run.prompter.questions[3]).toMatchObject({
      kind: "text",
      question: "EMAIL_FROM_NAME (Enter to skip)",
      optional: true,
    });
    expect(gateway().secrets["EMAIL_FROM"]).toBe("Acme <hello@example.com>");
    expect(gateway().secrets["EMAIL_FROM_NAME"]).toBeUndefined();
    expect(secretsOf(workerName)["GITHUB_TOKEN"]).toBe("ghp_x");
    expect(done()).toMatchObject({
      message: "Set EMAIL_FROM and GITHUB_TOKEN. crm is ready",
      data: { set: ["EMAIL_FROM", "GITHUB_TOKEN"] },
    });
  });

  it("walks an optional feature once the person says yes: its intro, then each value with its how", async () => {
    const dir = appDir(CRM);
    const workerName = await deploy(dir, CRM);
    gateway().secrets["OPENROUTER_API_KEY"] = "set";

    const run = configureAt(dir, {
      values: { DATAFORSEO_API_KEY: "k", TOKEN_ENCRYPTION_KEY: "tek", GITHUB_TOKEN: "ghp" },
      optional: true,
    });
    await run;

    expect(run.prompter.asked).toEqual(["DATAFORSEO_API_KEY", "TOKEN_ENCRYPTION_KEY", "GITHUB_TOKEN"]);
    expect(run.prompter.questions.at(-1)).toEqual({
      kind: "secret",
      question: "GITHUB_TOKEN (Enter to skip)",
      optional: true,
      context: ["GITHUB_TOKEN", "A fine-grained token with no permissions"],
    });
    expect(run.prompter.told.slice(-3)).toEqual(["", "GitHub", "Raises the GitHub rate limit."]);
    expect(secretsOf(workerName)["GITHUB_TOKEN"]).toBe("ghp");
    expect(done()!["data"]["set"]).toEqual(["DATAFORSEO_API_KEY", "TOKEN_ENCRYPTION_KEY", "GITHUB_TOKEN"]);
  });

  it("says what is set, nothing changed, when the person leaves the menu at once", async () => {
    await deploy(appDir(NOTES), NOTES);
    const dir = appDir(CRM);
    const workerName = await deploy(dir, CRM);
    gateway().secrets["DATAFORSEO_API_KEY"] = "set";
    gateway().secrets["OPENROUTER_API_KEY"] = "set";
    secretsOf(workerName)["TOKEN_ENCRYPTION_KEY"] = "set";
    const versions = account.cf.calls.length;

    await configureAt(emptyDir(), { picks: ["No, done"] }, { appId: "crm" });
    expect(done()).toMatchObject({ message: "crm is ready", data: { set: [] } });
    expect(done()!["data"]).not.toHaveProperty("changed");
    // Nothing was written: no secrets bulk call.
    expect(account.cf.calls.slice(versions).map((call) => call.args.slice(0, 3).join(" "))).not.toContain("workers secrets bulk");

    // An app that declares nothing: ready, no menu.
    events = [];
    const run = configureAt(emptyDir(), {}, { appId: "notes" });
    await run;
    expect(run.prompter.questions).toEqual([]);
    expect(done()).toMatchObject({ message: "notes is ready" });
  });

  it("in an app's directory before its first deploy, sets the Gateway's settings and leaves the app's own for after the deploy", async () => {
    const dir = appDir(CRM);

    const run = configureAt(dir, { values: { DATAFORSEO_API_KEY: "k", OPENROUTER_API_KEY: "sk" } });
    await run;

    // The GitHub feature's token waits for the deploy: nothing to offer yet.
    expect(run.prompter.asked).toEqual(["OPENROUTER_API_KEY", "DATAFORSEO_API_KEY"]);
    expect(run.prompter.questions.some((question) => question["kind"] === "confirm")).toBe(false);
    expect(run.prompter.told).toContain("TOKEN_ENCRYPTION_KEY        crm      after first deploy");
    expect(gateway().secrets).toMatchObject({ DATAFORSEO_API_KEY: "k", OPENROUTER_API_KEY: "sk" });
    // The app's own read as unknown until its Worker exists, which never
    // blocks: no warning, and the deploy is what comes next.
    expect(warnings()).toEqual([]);
    expect(done()).toMatchObject({
      message:
        "Set OPENROUTER_API_KEY and DATAFORSEO_API_KEY. crm's Gateway settings are set; its own TOKEN_ENCRYPTION_KEY and GITHUB_TOKEN come after its first deploy",
      data: {
        app: { id: "crm", deployed: false },
        next: [{ command: "pnpm everyapp deploy", note: "then pnpm everyapp configure crm for TOKEN_ENCRYPTION_KEY and GITHUB_TOKEN" }],
      },
    });

    // Still not ready (DataForSEO isn't set): the next and
    // the rerun are the directory form, since the name form is refused
    // until the first deploy.
    gateway().secrets["DATAFORSEO_API_KEY"] = "";
    delete gateway().secrets["DATAFORSEO_API_KEY"];
    events = [];
    await expect(configureFrom({ cwd: dir })).rejects.toMatchObject({
      code: "SECRET_VALUE_REQUIRED",
      rerun: "pnpm everyapp configure --from-env",
      rerunNote: "in the app's directory, with the variables exported",
      data: { names: ["DATAFORSEO_API_KEY"] },
    });
    events = [];
    await configureFrom({ cwd: dir, stdin: "CONTEXT_API_KEY=ctx\n" });
    expect(done()!["data"]["next"]).toEqual([
      { command: "pnpm everyapp configure", note: "in the app's directory: at a terminal, with NAME=value lines on stdin, or with --from-env" },
    ]);
  });

  it("changes nothing when the person cancels at a prompt", async () => {
    const dir = appDir(CRM);
    await deploy(dir, CRM);
    const prompter = scripted({});
    prompter.secret = async () => {
      throw new CancelledError();
    };
    await expect(
      configureApp({ flags, out: out(), cwd: dir, createCf, interactive: true, prompter, env: {}, readStdin: async () => null }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(gateway().secrets["DATAFORSEO_API_KEY"]).toBeUndefined();
    expect(done()).toBeUndefined();
  });

  it("fills what --from-env has and asks for the rest", async () => {
    const dir = appDir(CRM);
    const workerName = await deploy(dir, CRM);
    gateway().secrets["OPENROUTER_API_KEY"] = "old";

    const run = configureAt(
      dir,
      { values: { TOKEN_ENCRYPTION_KEY: "tek" } },
      { fromEnv: true, env: { DATAFORSEO_API_KEY: "from-env", OPENROUTER_API_KEY: "never-replaced", CONTEXT_API_KEY: "ctx" } },
    );
    await run;

    // The variable of a set name isn't taken: --from-env fills, never
    // replaces. An optional feature's unset one is filled too.
    expect(run.prompter.asked).toEqual(["TOKEN_ENCRYPTION_KEY"]);
    expect(gateway().secrets).toMatchObject({ DATAFORSEO_API_KEY: "from-env", OPENROUTER_API_KEY: "old", CONTEXT_API_KEY: "ctx" });
    expect(secretsOf(workerName)["TOKEN_ENCRYPTION_KEY"]).toBe("tek");
    expect(done()!["data"]["set"]).toEqual(["DATAFORSEO_API_KEY", "CONTEXT_API_KEY", "TOKEN_ENCRYPTION_KEY"]);
    expect(
      events.filter((event) => event["type"] === "progress" && event["step"] === "configure.env").map((event) => event["message"]),
    ).toEqual(["DATAFORSEO_API_KEY from $DATAFORSEO_API_KEY", "CONTEXT_API_KEY from $CONTEXT_API_KEY"]);
  });
});

describe("configure from a script", () => {
  it("sets NAME=value lines from stdin, each where it belongs, and names what is still missing", async () => {
    const dir = appDir(CRM);
    const workerName = await deploy(dir, CRM);

    await configureFrom({
      appId: "crm",
      stdin: "# the keys\nDATAFORSEO_API_KEY=login:password\nTOKEN_ENCRYPTION_KEY='tek'\nEMAIL_FROM=\"Acme <hello@example.com>\"\n",
    });

    expect(gateway().secrets).toMatchObject({ DATAFORSEO_API_KEY: "login:password", EMAIL_FROM: "Acme <hello@example.com>" });
    expect(secretsOf(workerName)["TOKEN_ENCRYPTION_KEY"]).toBe("tek");
    expect(warnings()).toEqual([
      expect.objectContaining({
        code: "APP_NEEDS_SETUP",
        step: "app.secrets",
        message: "crm won't open until OPENROUTER_API_KEY is set",
        data: { setup: expect.objectContaining({ ready: false }) },
      }),
    ]);
    expect(done()).toMatchObject({
      message: "Set DATAFORSEO_API_KEY, EMAIL_FROM and TOKEN_ENCRYPTION_KEY. crm still needs OPENROUTER_API_KEY",
      data: {
        set: ["DATAFORSEO_API_KEY", "EMAIL_FROM", "TOKEN_ENCRYPTION_KEY"],
        next: [{ command: "pnpm everyapp configure crm", note: "at a terminal, with NAME=value lines on stdin, or with --from-env" }],
      },
    });

    // The provider's key, from the environment: ready.
    events = [];
    await configureFrom({ appId: "crm", fromEnv: true, env: { OPENROUTER_API_KEY: "sk-or" } });
    expect(gateway().secrets["OPENROUTER_API_KEY"]).toBe("sk-or");
    expect(warnings()).toEqual([]);
    expect(done()).toMatchObject({ message: "Set OPENROUTER_API_KEY. crm is ready", data: { app: { setup: expect.objectContaining({ ready: true }) } } });
  });

  it("refuses a piped name the app doesn't declare, a blank value, and a bad plain value, before anything is written", async () => {
    const dir = appDir(CRM);
    await deploy(dir, CRM);
    const calls = account.cf.calls.length;

    await expect(configureFrom({ appId: "crm", stdin: "DATAFORSEO_API_KEY=k\nSTRIPE_KEY=x\n" })).rejects.toMatchObject({
      code: "SECRET_NOT_DECLARED",
      message: expect.stringContaining("crm doesn't declare STRIPE_KEY"),
      fix: "leave it out, or declare it in everyapp.config.ts and deploy again; a bare value goes to pnpm everyapp secret set NAME",
    });
    // A bare value (the `echo "$KEY" | …` habit): refused without a word of it shown.
    const base64 = "dGVzdEBleGFtcGxlLmNvbTpwYXNzd29yZA==";
    const bare = await failureOf(configureFrom({ appId: "crm", stdin: `${base64}\n` }));
    expect(bare).toMatchObject({ code: "SECRET_NOT_DECLARED" });
    expect(bare.message).toContain("crm doesn't declare line 1 (not shown: it may be a value)");
    expect(`${bare.message}\n${bare.fix}`).not.toContain("dGVzdEBleGFtcGxl");
    const plain = await failureOf(configureFrom({ appId: "crm", stdin: "sk-or-v1-abcdef\n" }));
    expect(plain).toMatchObject({ code: "PIPED_LINE_INVALID", message: "Line 1 of the piped input isn't NAME=value\nNothing was set." });
    expect(plain.message).not.toContain("sk-or");
    await expect(configureFrom({ appId: "crm", stdin: "DATAFORSEO_API_KEY=\n" })).rejects.toMatchObject({
      code: "SECRET_EMPTY",
      message: "DATAFORSEO_API_KEY is empty in the piped lines",
    });
    await expect(configureFrom({ appId: "crm", stdin: "EMAIL_FROM=not-an-address\n" })).rejects.toMatchObject({
      code: "SETTING_VALUE_INVALID",
    });
    expect(gateway().secrets["DATAFORSEO_API_KEY"]).toBeUndefined();
    expect(account.cf.calls.slice(calls).map((call) => call.args.slice(0, 3).join(" "))).not.toContain("workers secrets bulk");
  });

  it("stops with SECRET_VALUE_REQUIRED when nothing can be read and something required is unset", async () => {
    await deploy(appDir(CRM), CRM);
    await expect(configureFrom({ appId: "crm" })).rejects.toMatchObject({
      code: "SECRET_VALUE_REQUIRED",
      message:
        "Can't ask for crm's settings without a terminal\ncrm needs OPENROUTER_API_KEY, DATAFORSEO_API_KEY and TOKEN_ENCRYPTION_KEY. Run this at a terminal, pipe NAME=value lines in (one per line), or export them under those names and add --from-env (which also takes the variable of any unset optional setting).",
      rerun: "pnpm everyapp configure crm --from-env",
      rerunNote: "with the variables exported",
      data: { names: ["OPENROUTER_API_KEY", "DATAFORSEO_API_KEY", "TOKEN_ENCRYPTION_KEY"] },
    });
    // --from-env with none of the variables set reads nothing either.
    await expect(configureFrom({ appId: "crm", fromEnv: true, env: { OTHER: "x" } })).rejects.toMatchObject({
      code: "SECRET_VALUE_REQUIRED",
    });
    expect(done()).toBeUndefined();
  });

  it("is done with nothing to set for an app that is ready", async () => {
    const dir = appDir(CRM);
    const workerName = await deploy(dir, CRM);
    gateway().secrets["DATAFORSEO_API_KEY"] = "set";
    gateway().secrets["OPENROUTER_API_KEY"] = "set";
    secretsOf(workerName)["TOKEN_ENCRYPTION_KEY"] = "set";

    await configureFrom({ appId: "crm" });
    expect(done()).toMatchObject({ message: "crm is ready", data: { set: [], app: { setup: expect.objectContaining({ ready: true }) } } });
  });

  it("refuses an app that isn't deployed, a directory with no app, and a value on the command line", async () => {
    await expect(configureFrom({ appId: "crm" })).rejects.toMatchObject({
      code: "APP_NOT_FOUND",
      message: expect.stringContaining("crm isn't deployed to this Gateway"),
      rerun: "pnpm everyapp status",
    });
    await expect(configureFrom({})).rejects.toMatchObject({
      code: "MANIFEST_NOT_FOUND",
      message: "No everyapp.config.ts in this directory, and no app named",
      fix: "name the app: pnpm everyapp configure <app> (pnpm everyapp status lists them), or run this from its directory",
    });
    // A value typed after the verb is in the shell's history already; nothing is read or set.
    const calls = account.cf.calls.length;
    await expect(configureFrom({ appId: "DATAFORSEO_API_KEY=login:password" })).rejects.toMatchObject({
      code: "VALUE_ON_COMMAND_LINE",
      message: expect.stringContaining("DATAFORSEO_API_KEY=… looks like a value on the command line"),
      fix: "pipe NAME=value lines in (one per line), or export DATAFORSEO_API_KEY and add --from-env",
    });
    expect(account.cf.calls.length).toBe(calls);
  });

  it("takes a piped value as it is: a # or an = inside it, one pair of quotes dropped, export allowed, the last line for a name winning", async () => {
    const dir = appDir(CRM);
    const workerName = await deploy(dir, CRM);

    await configureFrom({
      appId: "crm",
      stdin: [
        "# comment",
        "export DATAFORSEO_API_KEY=login:p#ss=w0rd",
        `TOKEN_ENCRYPTION_KEY="quoted # value"`,
        "GITHUB_TOKEN='first'",
        "GITHUB_TOKEN=second",
        "  ",
      ].join("\n"),
    });
    expect(gateway().secrets["DATAFORSEO_API_KEY"]).toBe("login:p#ss=w0rd");
    expect(secretsOf(workerName)["TOKEN_ENCRYPTION_KEY"]).toBe("quoted # value");
    expect(secretsOf(workerName)["GITHUB_TOKEN"]).toBe("second");
  });

  it("accepts on stdin a name a capability also reads, and never prompts for it", async () => {
    const dir = appDir(CRM);
    await deploy(dir, CRM);
    // RESEND_API_KEY is none of email's names (EMAIL_FROM, EMAIL_FROM_NAME):
    // one it reads when set, never asked for.
    await configureFrom({ appId: "crm", stdin: "RESEND_API_KEY=re_x\nOPENROUTER_API_KEY=sk\n" });
    expect(gateway().secrets["RESEND_API_KEY"]).toBe("re_x");
    expect(done()!["data"]["set"]).toEqual(["OPENROUTER_API_KEY", "RESEND_API_KEY"]);
  });

  it("asks only for the missing name of a setting with several, and --from-env never fills a set one", async () => {
    const manifest: EveryAppCliManifest = {
      id: "crm",
      resources: { d1: ["DB"] },
      capabilities: { "google-workspace": { scopes: ["gmail.readonly"], why: "Reads mail." } },
    };
    const dir = appDir(manifest);
    await deploy(dir, manifest);
    gateway().secrets["GOOGLE_WORKSPACE_CLIENT_ID"] = "id-set-before";

    const run = configureAt(
      dir,
      { values: { GOOGLE_WORKSPACE_CLIENT_SECRET: "secret" } },
      { fromEnv: true, env: { GOOGLE_WORKSPACE_CLIENT_ID: "from-env" } },
    );
    await run;
    expect(run.prompter.asked).toEqual(["GOOGLE_WORKSPACE_CLIENT_SECRET"]);
    expect(gateway().secrets).toMatchObject({ GOOGLE_WORKSPACE_CLIENT_ID: "id-set-before", GOOGLE_WORKSPACE_CLIENT_SECRET: "secret" });
    expect(done()).toMatchObject({ message: "Set GOOGLE_WORKSPACE_CLIENT_SECRET. crm is ready" });

    // Without a terminal, the missing name alone is asked for.
    delete gateway().secrets["GOOGLE_WORKSPACE_CLIENT_SECRET"];
    events = [];
    await expect(configureFrom({ appId: "crm" })).rejects.toMatchObject({
      code: "SECRET_VALUE_REQUIRED",
      data: { names: ["GOOGLE_WORKSPACE_CLIENT_SECRET"] },
    });
  });

  it("leaves stdin alone with --from-env, and treats a row whose first deploy never finished as undeployed", async () => {
    const dir = appDir(CRM);
    await deploy(dir, CRM);
    let read = false;
    await configureApp({
      flags: { ...flags, "from-env": true },
      out: out(),
      cwd: emptyDir(),
      createCf,
      interactive: false,
      appId: "crm",
      env: { DATAFORSEO_API_KEY: "k" },
      readStdin: async () => {
        read = true;
        return "OPENROUTER_API_KEY=never\n";
      },
    });
    expect(read).toBe(false);
    expect(gateway().secrets["OPENROUTER_API_KEY"]).toBeUndefined();
    expect(gateway().secrets["DATAFORSEO_API_KEY"]).toBe("k");

    // The row is marked pending again (a redeploy that stopped): no Worker to read.
    const row = await readApp(db(), "crm");
    await db().run([{ sql: "UPDATE apps SET status = 'pending' WHERE id = ?", params: [row.id] }]);
    events = [];
    await expect(configureFrom({ appId: "crm", stdin: "OPENROUTER_API_KEY=sk\n" })).rejects.toMatchObject({
      code: "APP_NOT_FOUND",
      message: expect.stringContaining("crm isn't deployed to this Gateway"),
    });
    // In its directory: the Gateway's settings go, the app's own wait.
    events = [];
    await configureFrom({ cwd: dir, stdin: "OPENROUTER_API_KEY=sk\n" });
    expect(gateway().secrets["OPENROUTER_API_KEY"]).toBe("sk");
    expect(done()!["data"]["app"]).toMatchObject({ deployed: false });
  });

  it("after a partial failure, says to run configure again, not a secret set from nowhere", async () => {
    const dir = appDir(CRM);
    const workerName = await deploy(dir, CRM);
    account.cf.override(
      (args) => args.slice(0, 3).join(" ") === "workers secrets bulk" && args.includes(workerName),
      { exitCode: 1, stderr: "┌ Error\n│ Authentication error [code: 10000]\n└\n" },
    );
    await expect(
      configureFrom({ appId: "crm", stdin: "DATAFORSEO_API_KEY=k\nTOKEN_ENCRYPTION_KEY=tek\n" }),
    ).rejects.toMatchObject({
      code: "SECRETS_PARTIALLY_APPLIED",
      rerun: "pnpm everyapp configure crm",
      rerunNote: "to set what is left",
      data: { left: ["TOKEN_ENCRYPTION_KEY"] },
    });
    expect(gateway().secrets["DATAFORSEO_API_KEY"]).toBe("k");
  });

  it("refuses an app's own secret on stdin before its first deploy, and sets the Gateway's", async () => {
    const dir = appDir(CRM);
    await expect(configureFrom({ cwd: dir, stdin: "TOKEN_ENCRYPTION_KEY=tek\n" })).rejects.toMatchObject({
      code: "APP_NOT_FOUND",
      message: "crm isn't deployed yet\nIts own TOKEN_ENCRYPTION_KEY can be set after its first deploy. Nothing was set.",
      rerun: "pnpm everyapp deploy",
    });
    events = [];
    await configureFrom({ cwd: dir, stdin: "DATAFORSEO_API_KEY=k\nOPENROUTER_API_KEY=sk\n" });
    expect(gateway().secrets).toMatchObject({ DATAFORSEO_API_KEY: "k", OPENROUTER_API_KEY: "sk" });
    expect(done()).toMatchObject({
      message:
        "Set OPENROUTER_API_KEY and DATAFORSEO_API_KEY. crm's Gateway settings are set; its own TOKEN_ENCRYPTION_KEY and GITHUB_TOKEN come after its first deploy",
      data: {
        app: { deployed: false },
        next: [{ command: "pnpm everyapp deploy", note: "then pnpm everyapp configure crm for TOKEN_ENCRYPTION_KEY and GITHUB_TOKEN" }],
      },
    });
  });

  it("sets a registered provider's key on the Gateway and binds it to the row's hosts", async () => {
    const northwind = {
      id: "northwind",
      name: "Northwind",
      docs: "https://developer.northwind.io/keys",
      hosts: ["api.northwind.io"],
      auth: { kind: "bearer", secret: "NORTHWIND_API_KEY" },
      hint: "A restricted key from the Northwind dashboard.",
    };
    await addProvider(db(), { spec: northwind, deployer: { actor: "ops@example.com", email: "ops@example.com" }, install: (await readInstall(db()))! });
    const shop: EveryAppCliManifest = { id: "shop", resources: { d1: ["DB"] }, capabilities: { northwind: { access: "read" } } };
    await deploy(appDir(shop), shop);

    // At a terminal, the prompt says what the key is and where the spec is.
    const asked = configureAt(emptyDir(), { values: { NORTHWIND_API_KEY: "sk_test" } }, { appId: "shop" });
    await asked;
    expect(asked.prompter.questions[0]).toMatchObject({
      kind: "secret",
      question: "NORTHWIND_API_KEY",
      context: [
        "Northwind: NORTHWIND_API_KEY",
        "A restricted key from the Northwind dashboard.",
        "Get it at https://developer.northwind.io/keys",
        "Guide: pnpm everyapp provider show northwind",
      ],
    });
    expect(gateway().secrets["NORTHWIND_API_KEY"]).toBe("sk_test");
    const [row] = (await db().run([{ sql: "SELECT bound_to FROM providers WHERE id = 'northwind'" }]))[0]!;
    expect(row!["bound_to"]).toEqual(expect.stringContaining('"hosts":["api.northwind.io"]'));
    expect(done()).toMatchObject({ message: "Set NORTHWIND_API_KEY. shop is ready", data: { changed: { gateway: { bound: ["northwind"] } } } });
  });
});

/** An app with plain settings: a URL and a number it needs, a region it may take. */
const MC: EveryAppCliManifest = {
  id: "mc",
  resources: { d1: ["DB"] },
  settings: [
    { name: "POSTHOG_HOST", why: "Where the PostHog API is.", type: "url" },
    { name: "POSTHOG_PROJECT_ID", why: "Which PostHog project the dashboards read.", type: "number" },
  ],
  features: {
    reports: { name: "Reports", why: "Dated reports.", settings: [{ name: "REGION", how: "Where reports are dated", values: ["us", "eu"] }] },
  },
};

describe("an app's plain settings", () => {
  it("sets them on the app's Worker from stdin, each checked, and the app opens", async () => {
    const dir = appDir(MC);
    const workerName = await deploy(dir, MC);
    await configureFrom({ cwd: dir, stdin: "POSTHOG_HOST=https://eu.i.posthog.com\nPOSTHOG_PROJECT_ID=42\n" });
    expect(secretsOf(workerName)["POSTHOG_HOST"]).toBe("https://eu.i.posthog.com");
    expect(secretsOf(workerName)["POSTHOG_PROJECT_ID"]).toBe("42");
    expect(done()!["message"]).toBe("Set POSTHOG_HOST and POSTHOG_PROJECT_ID. mc is ready");
  });

  it("asks for one at a visible prompt, says what it takes, and checks the answer", async () => {
    const dir = appDir(MC);
    const workerName = await deploy(dir, MC);
    const run = configureAt(dir, { values: { POSTHOG_HOST: "https://us.i.posthog.com", POSTHOG_PROJECT_ID: "123" } });
    await run;
    const asked = run.prompter.questions.find((question) => question["question"] === "POSTHOG_PROJECT_ID")!;
    expect(asked["kind"]).toBe("text");
    expect(asked["context"]).toEqual([
      "POSTHOG_PROJECT_ID: Which PostHog project the dashboards read.",
      "Takes a number",
    ]);
    expect(secretsOf(workerName)["POSTHOG_PROJECT_ID"]).toBe("123");
    expect(done()!["message"]).toBe("Set POSTHOG_HOST and POSTHOG_PROJECT_ID. mc is ready");

    const other = appDir({ ...MC, id: "mc2" });
    await deploy(other, { ...MC, id: "mc2" });
    const refused = configureAt(other, { values: { POSTHOG_HOST: "https://us.i.posthog.com", POSTHOG_PROJECT_ID: "abc" } });
    expect((await failureOf(refused)).message).toContain('POSTHOG_PROJECT_ID: "abc" isn\'t a number.');
  });

  it("refuses a piped or exported value the setting doesn't take, before anything is written", async () => {
    const dir = appDir(MC);
    const workerName = await deploy(dir, MC);
    const piped = await failureOf(configureFrom({ cwd: dir, stdin: "POSTHOG_PROJECT_ID=12\nREGION=mars\n" }));
    expect(piped.code).toBe("SETTING_VALUE_INVALID");
    expect(piped.message).toBe('REGION can\'t be "mars"\nNot us or eu.');
    expect(piped.fix).toBe("use us or eu");
    const exported = await failureOf(
      configureFrom({ cwd: dir, fromEnv: true, env: { POSTHOG_PROJECT_ID: "twelve" } }),
    );
    expect(exported.code).toBe("SETTING_VALUE_INVALID");
    expect(secretsOf(workerName)["POSTHOG_PROJECT_ID"]).toBeUndefined();
  });

  it("needs setup while a required one is unset, and says what it takes", async () => {
    const dir = appDir(MC);
    await deploy(dir, MC);
    await configureFrom({ cwd: dir, stdin: "POSTHOG_HOST=https://us.i.posthog.com\nREGION=eu\n" });
    const warning = warnings().find((event) => event["code"] === "APP_NEEDS_SETUP")!;
    const unmet = warning["data"].setup.unmet;
    expect(unmet.map((setting: { id: string }) => setting.id)).toEqual(["POSTHOG_PROJECT_ID"]);
    expect(unmet[0].value).toEqual({ type: "number" });
  });

  it("the deploy writes a default nobody has set, never over a value someone set", async () => {
    const withDefault: EveryAppCliManifest = {
      ...MC,
      id: "mcd",
      settings: [
        { name: "POSTHOG_HOST", why: "Where the PostHog API is.", type: "url", default: "https://us.i.posthog.com" },
        { name: "POSTHOG_PROJECT_ID", why: "Which PostHog project the dashboards read.", type: "number" },
      ],
    };
    const dir = appDir(withDefault);
    const workerName = await deploy(dir, withDefault);
    expect(secretsOf(workerName)["POSTHOG_HOST"]).toBe("https://us.i.posthog.com");
    expect(secretsOf(workerName)["POSTHOG_PROJECT_ID"]).toBeUndefined();
    await configureFrom({ cwd: dir, stdin: "POSTHOG_HOST=https://eu.i.posthog.com\nPOSTHOG_PROJECT_ID=42\n" });
    await deploy(dir, withDefault);
    expect(secretsOf(workerName)["POSTHOG_HOST"]).toBe("https://eu.i.posthog.com");
    expect(secretsOf(workerName)["POSTHOG_PROJECT_ID"]).toBe("42");
  });
});

/**
 * An app with features: a top-level key the deploy generates, a required
 * GitHub feature (steps, a setting, a file, a secret to paste somewhere)
 * and an optional Slack one (secrets of its own, one generated silently,
 * and a Gateway capability).
 */
const BIRDS: EveryAppCliManifest = {
  id: "birds",
  resources: { d1: ["DB"] },
  capabilities: {
    dataforseo: { access: "read", why: "Keyword data." },
    context: { access: "read" },
  },
  secrets: [{ name: "BIRDS_SECRETS_KEY", generate: true }],
  features: {
    github: {
      name: "GitHub",
      required: true,
      why: "Agents open pull requests.",
      steps: [
        "Create a GitHub App: https://github.com/settings/apps/new",
        "Webhook URL: {appUrl}/github/webhooks. See [the docs](https://docs.github.com/apps).",
      ],
      settings: [{ name: "GITHUB_APP_ID", how: "The App's General page → App ID" }],
      secrets: [
        { name: "GITHUB_APP_PRIVATE_KEY", file: true, how: "General → Private keys → Generate" },
        { name: "GITHUB_WEBHOOK_SECRET", generate: true, how: "Paste this into the App's Webhook secret" },
      ],
    },
    slack: {
      name: "Slack",
      why: "Agents talk in Slack.",
      secrets: ["SLACK_SIGNING_SECRET", "SLACK_BOT_TOKEN", { name: "SLACK_STATE_KEY", generate: true }],
      capabilities: ["context"],
    },
  },
};

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nIBAAKC\n-----END RSA PRIVATE KEY-----\n";

/** A .pem file in a temporary directory. */
function pemFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-configure-pem-"));
  dirs.push(dir);
  const file = path.join(dir, "app.pem");
  fs.writeFileSync(file, PEM);
  return file;
}

describe("features", () => {
  it("asks for the top level first, then walks the required feature with its steps, then offers the optional one", async () => {
    const dir = appDir(BIRDS);
    const workerName = await deploy(dir, BIRDS);
    // The deploy generated the top-level key, so the app opens without a step for it.
    expect(secretsOf(workerName)["BIRDS_SECRETS_KEY"]).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const file = pemFile();
    const run = configureAt(dir, {
      values: {
        DATAFORSEO_API_KEY: "login:password",
        "GITHUB_APP_PRIVATE_KEY (a file's path, or its contents)": file,
        GITHUB_APP_ID: "123",
      },
    });
    await run;

    expect(run.prompter.asked).toEqual([
      "DATAFORSEO_API_KEY",
      "GITHUB_APP_PRIVATE_KEY (a file's path, or its contents)",
      "GITHUB_APP_ID",
    ]);
    const told = run.prompter.told;
    const intro = told.indexOf("GitHub");
    expect(told.slice(intro, intro + 4)).toEqual([
      "GitHub",
      "Agents open pull requests.",
      "1. Create a GitHub App: https://github.com/settings/apps/new",
      "2. Webhook URL: https://birds.example.com/github/webhooks. See the docs (https://docs.github.com/apps).",
    ]);
    // A value's how is above its prompt.
    expect(run.prompter.questions.find((question) => question["question"] === "GITHUB_APP_ID")).toMatchObject({
      kind: "text",
      context: ["GITHUB_APP_ID", "The App's General page → App ID", "Takes any text"],
    });
    // The webhook secret is made, set, and shown once with where it goes; never in the events.
    const secrets = secretsOf(workerName);
    const generated = secrets["GITHUB_WEBHOOK_SECRET"]!;
    expect(generated).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(told.filter((line) => line.includes(generated))).toEqual([`GITHUB_WEBHOOK_SECRET, generated: ${generated}`]);
    expect(told[told.indexOf(`GITHUB_WEBHOOK_SECRET, generated: ${generated}`) + 1]).toBe("Paste this into the App's Webhook secret");
    expect(JSON.stringify(events)).not.toContain(generated);
    // The file's contents, exactly.
    expect(secrets["GITHUB_APP_PRIVATE_KEY"]).toBe(PEM);
    expect(secrets["GITHUB_APP_ID"]).toBe("123");
    // Then the optional feature, declined: off, and the app ready.
    expect(run.prompter.questions.at(-1)).toEqual({ kind: "confirm", question: "Set up Slack?", context: ["Agents talk in Slack."] });
    expect(secrets["SLACK_SIGNING_SECRET"]).toBeUndefined();
    expect(secrets["SLACK_STATE_KEY"]).toBeUndefined();
    expect(warnings()).toEqual([]);
    expect(done()).toMatchObject({ message: expect.stringMatching(/birds is ready$/) });
    expect(done()!["data"]["features"].map((feature: { id: string; state: string }) => [feature.id, feature.state])).toEqual([
      ["github", "ready"],
      ["slack", "off"],
    ]);
  });

  it("gives a script every feature with its steps filled, values and needs, and takes a multi-line PEM from the environment", async () => {
    const dir = appDir(BIRDS);
    const workerName = await deploy(dir, BIRDS);
    gateway().secrets["DATAFORSEO_API_KEY"] = "set";

    // Nothing to read: the webhook secret is pasted somewhere, so a script isn't given one it never sees.
    const refused = await failureOf(configureFrom({ appId: "birds" }));
    expect(refused).toMatchObject({
      code: "SECRET_VALUE_REQUIRED",
      data: { names: ["GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET", "GITHUB_APP_ID"] },
    });
    expect(secretsOf(workerName)["GITHUB_WEBHOOK_SECRET"]).toBeUndefined();
    const features = (refused as unknown as { data: { features: unknown[] } }).data.features;
    expect(features).toEqual([
      {
        id: "github",
        name: "GitHub",
        required: true,
        why: "Agents open pull requests.",
        steps: [
          "Create a GitHub App: https://github.com/settings/apps/new",
          "Webhook URL: https://birds.example.com/github/webhooks. See [the docs](https://docs.github.com/apps).",
        ],
        values: [
          { name: "GITHUB_APP_PRIVATE_KEY", kind: "secret", how: "General → Private keys → Generate", set: false, generate: false, file: true },
          { name: "GITHUB_WEBHOOK_SECRET", kind: "secret", how: "Paste this into the App's Webhook secret", set: false, generate: true, file: false },
          { name: "GITHUB_APP_ID", kind: "setting", how: "The App's General page → App ID", set: false, generate: false, file: false },
        ],
        needs: [],
        state: "off",
      },
      {
        id: "slack",
        name: "Slack",
        required: false,
        why: "Agents talk in Slack.",
        steps: [],
        values: [
          { name: "SLACK_SIGNING_SECRET", kind: "secret", set: false, generate: false, file: false },
          { name: "SLACK_BOT_TOKEN", kind: "secret", set: false, generate: false, file: false },
          { name: "SLACK_STATE_KEY", kind: "secret", set: false, generate: true, file: false },
        ],
        needs: [
          {
            kind: "capability",
            id: "context",
            label: "Context.dev",
            set: false,
            command: "pnpm everyapp provider add context",
          },
        ],
        state: "off",
      },
    ]);

    events = [];
    await configureFrom({
      appId: "birds",
      fromEnv: true,
      env: { GITHUB_APP_PRIVATE_KEY: PEM, GITHUB_APP_ID: "123", GITHUB_WEBHOOK_SECRET: "whs" },
    });
    expect(secretsOf(workerName)).toMatchObject({ GITHUB_APP_PRIVATE_KEY: PEM, GITHUB_APP_ID: "123", GITHUB_WEBHOOK_SECRET: "whs" });
    expect(done()).toMatchObject({ message: expect.stringMatching(/birds is ready$/) });
    expect(done()!["data"]["features"][0]).toMatchObject({ id: "github", state: "ready" });

    // A file's path from the environment reads the file.
    delete secretsOf(workerName)["GITHUB_APP_PRIVATE_KEY"];
    events = [];
    await configureFrom({ appId: "birds", fromEnv: true, env: { GITHUB_APP_PRIVATE_KEY: pemFile() } });
    expect(secretsOf(workerName)["GITHUB_APP_PRIVATE_KEY"]).toBe(PEM);
  });

  it("turns an optional feature on with a value piped in, generates its silent secret, and warns while it is half set", async () => {
    const dir = appDir(BIRDS);
    const workerName = await deploy(dir, BIRDS);
    gateway().secrets["DATAFORSEO_API_KEY"] = "set";
    Object.assign(secretsOf(workerName), { GITHUB_APP_PRIVATE_KEY: PEM, GITHUB_APP_ID: "1", GITHUB_WEBHOOK_SECRET: "w" });

    await configureFrom({ appId: "birds", stdin: "SLACK_SIGNING_SECRET=sss\n" });
    const secrets = secretsOf(workerName);
    expect(secrets["SLACK_SIGNING_SECRET"]).toBe("sss");
    expect(secrets["SLACK_STATE_KEY"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(events)).not.toContain(secrets["SLACK_STATE_KEY"]!);
    expect(warnings()).toEqual([
      expect.objectContaining({
        code: "FEATURE_INCOMPLETE",
        message: "Slack is half set up: CONTEXT_API_KEY and SLACK_BOT_TOKEN aren't set",
        data: { feature: "slack", names: ["CONTEXT_API_KEY", "SLACK_BOT_TOKEN"] },
      }),
    ]);
    // Half set never blocks.
    expect(done()).toMatchObject({
      message: expect.stringMatching(/birds is ready$/),
      data: { app: { setup: expect.objectContaining({ ready: true }) } },
    });
    expect(done()!["data"]["features"][1]).toMatchObject({ id: "slack", state: "incomplete" });
  });
});
