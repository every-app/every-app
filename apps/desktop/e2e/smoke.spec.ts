// End-to-end smoke of the real app: main, preload and renderer as built (`pnpm build`), the fake
// helper for audio, and an in-memory mock of /api/v1. It runs with its own temporary
// --user-data-dir, so it never takes the installed Every App Dev's single-instance lock or touches its
// settings, sign-in or logs. On failure it keeps a screenshot and a Playwright trace
// (test-results/e2e, uploaded by CI).

import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

// Playwright loads this spec as CommonJS (desktop/ isn't "type": "module").
const root = resolve(__dirname, "..");

/** The mock /api/v1 (e2e/mock-api.mjs) in its own Node process, driven over HTTP. */
class Mock {
  private constructor(
    readonly url: string,
    private readonly child: ChildProcess,
  ) {}

  static start(): Promise<Mock> {
    const child = spawn(process.execPath, [join(__dirname, "mock-api.mjs")], { env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "inherit"] });
    return new Promise((done, fail) => {
      child.once("exit", (code) => fail(new Error(`the mock API exited (${code})`)));
      child.stdout!.on("data", (chunk: Buffer) => {
        const url = /on (http:\/\/127\.0\.0\.1:\d+)/.exec(chunk.toString())?.[1];
        if (url) done(new Mock(url, child));
      });
    });
  }

  async setMode(mode: "online" | "offline" | "unauthorized"): Promise<void> {
    const res = await fetch(`${this.url}/__mock/mode`, { method: "POST", body: JSON.stringify({ mode }) });
    if (!res.ok) throw new Error(`mode ${mode}: HTTP ${res.status}`);
  }

  async requests(): Promise<string[]> {
    return (await this.log()).requests;
  }

  async log(): Promise<{ requests: string[]; segmentBatches: { meetingId: string; count: number; seqs: number[]; refused: boolean }[] }> {
    return (await (await fetch(`${this.url}/__mock/requests`)).json()) as never;
  }

  /** The seqs of the segments the mock holds for a meeting. */
  async segmentSeqs(meetingId: string): Promise<number[]> {
    const res = await fetch(`${this.url}/api/v1/meetings/${encodeURIComponent(meetingId)}`, { headers: { authorization: "Bearer e2e" } });
    const body = (await res.json()) as { meeting: { segments: { seq: number }[] } };
    return body.meeting.segments.map((s) => s.seq).sort((a, b) => a - b);
  }

  close(): void {
    this.child.kill();
  }
}

let mock: Mock;
let burstFile: string;

/** Main's connection state: "online", "offline" or "signin-needed". */
async function connectionState(): Promise<string> {
  return page.evaluate(async () => {
    const bridge = (window as unknown as { everyapp: { "state:get"(): Promise<{ connection: string }> } }).everyapp;
    return (await bridge["state:get"]()).connection;
  });
}

/** Main's view of the recording (the window's own state:get), e.g. "recording", "stopping", "idle". */
async function recordingState(): Promise<string> {
  return page.evaluate(async () => {
    const bridge = (window as unknown as { everyapp: { "state:get"(): Promise<{ recording: { state: string } }> } }).everyapp;
    return (await bridge["state:get"]()).recording.state;
  });
}
let app: ElectronApplication;
let page: Page;
let userData: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  mock = await Mock.start();
  userData = realpathSync(mkdtempSync(join(tmpdir(), "everyapp-e2e-")));
  burstFile = join(userData, "burst");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, {
    EVERYAPP_DESKTOP_DEV_APP_URL: mock.url,
    EVERYAPP_DESKTOP_DEV_TOKEN: "e2e-token",
    FAKE_HELPER_LINE_MS: "600",
    // A fake updater that finds and "downloads" this version at launch (dev builds only).
    EVERYAPP_DESKTOP_E2E_FAKE_UPDATE: "9.9.9",
    // While this file exists, the fake helper makes a transcript line every 20 ms.
    FAKE_HELPER_BURST_FILE: burstFile,
    // No real recorder, ever: the unpackaged app runs scripts/fake-helper.mjs unless this is set.
    EVERYAPP_DESKTOP_HELPER_PATH: "",
  });
  const args = [root, `--user-data-dir=${userData}`];
  // GitHub's Linux runners can't use Chromium's setuid sandbox.
  if (process.platform === "linux") args.push("--no-sandbox");
  app = await electron.launch({ executablePath: require("electron") as unknown as string, args, env, cwd: root });
  await app.context().tracing.start({ screenshots: true, snapshots: true });
  page = await app.firstWindow();
  // Never steal focus for long: the window shows (rendering needs it) but stays where it is.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1200, 800));
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus && page && !page.isClosed()) {
    await page.screenshot({ path: testInfo.outputPath("failure.png") }).catch(() => {});
    await app.context().tracing.stop({ path: testInfo.outputPath("trace.zip") }).catch(() => {});
    await app.context().tracing.start({ screenshots: true, snapshots: true }).catch(() => {});
  }
});

test.afterAll(async () => {
  await app?.context().tracing.stop().catch(() => {});
  await app?.close().catch(() => {});
  mock?.close();
  if (userData) rmSync(userData, { recursive: true, force: true });
});

test("launches signed in through the dev env, shows first-run, then Home", async () => {
  // First run asks for permissions (Continue waits for the mic, which CI can't grant): it shows,
  // then it's skipped the way a finished onboarding is remembered.
  await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();
  await page.evaluate(() => localStorage.setItem("everyapp.onboarded", "1"));
  await page.reload();
  await expect(page.getByText("Coming up")).toBeVisible();
  await expect(page.getByRole("button", { name: /Northwind pricing follow-up/ })).toBeVisible();
  // The profile is the temp one: main wrote its files there.
  const where = await app.evaluate(({ app: a }) => a.getPath("userData"));
  expect(where).toBe(userData);
});

test("opens a meeting and switches its tabs", async () => {
  await page.getByRole("button", { name: /Northwind pricing follow-up/ }).click();
  for (const name of ["Transcript", "Your jottings", "Notes"]) {
    const tab = page.getByRole("tab", { name });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
  }
});

test("⌘N records with the fake helper: jottings, live transcript, Stop", async () => {
  await page.evaluate(() => (location.hash = "#/"));
  await expect(page.getByText("Coming up")).toBeVisible();
  await page.keyboard.press("Meta+n");
  await page.waitForURL(/#\/meetings\//);
  const notepad = page.getByRole("textbox", { name: "Your notes" });
  await notepad.click();
  await page.keyboard.type("- e2e jotting one\nsecond point");
  await page.getByRole("button", { name: /Transcript/ }).click();
  const drawer = page.getByRole("complementary", { name: "Live transcript" });
  await expect(drawer.getByText("Thanks everyone for joining.")).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1200); // the notepad autosaves after an 800 ms pause
  await page.getByRole("button", { name: /^Stop$/ }).click();
  // Stop turns into "Finishing…" as soon as the stop begins (#40), so that alone doesn't mean the
  // helper is done: wait for main to say the recording is over, then for the requests it made.
  await expect.poll(recordingState, { timeout: 20_000 }).toBe("idle");
  await expect
    .poll(async () => (await mock.requests()).some((r) => /^POST \/api\/v1\/meetings\/[^/]+\/segments$/.test(r)), { timeout: 10_000 })
    .toBe(true);
  await expect
    .poll(async () => (await mock.requests()).some((r) => /^POST \/api\/v1\/meetings\/[^/]+\/finish$/.test(r)), { timeout: 10_000 })
    .toBe(true);
});

test("the jottings are still there after reopening the meeting", async () => {
  const meetingHash = await page.evaluate(() => location.hash);
  await page.evaluate(() => (location.hash = "#/"));
  await expect(page.getByText("Coming up")).toBeVisible();
  await page.evaluate((h) => (location.hash = h), meetingHash);
  await page.getByRole("tab", { name: "Your jottings" }).click();
  const jottings = page.getByRole("textbox", { name: "Your jottings" });
  await expect(jottings).toHaveValue(/e2e jotting one[\s\S]*second point/);
  // And the server has them (not just the window's cache).
  const id = decodeURIComponent(meetingHash.split("/").pop() ?? "");
  const stored = (await (await fetch(`${mock.url}/api/v1/meetings/${encodeURIComponent(id)}`, { headers: { authorization: "Bearer e2e" } })).json()) as {
    meeting: { jottings: { markdown: string } | null };
  };
  expect(stored.meeting.jottings?.markdown).toMatch(/e2e jotting one[\s\S]*second point/);
});

test("a Settings switch persists across a reload", async () => {
  await page.evaluate(() => (location.hash = "#/settings"));
  const calls = page.getByRole("switch", { name: "Ask to record calls" });
  await expect(calls).toBeVisible();
  const before = await calls.getAttribute("aria-checked");
  await calls.click();
  const after = before === "true" ? "false" : "true";
  await expect(calls).toHaveAttribute("aria-checked", after);
  await page.reload();
  await expect(page.getByRole("switch", { name: "Ask to record calls" })).toHaveAttribute("aria-checked", after);
  // Main is the one that kept it, in the temp profile.
  expect(JSON.parse(readFileSync(join(userData, "settings.json"), "utf8")).callDetection).toBe(after === "true");
});

test("Settings → Check microphone & Mac audio runs live until Stop and names both devices", async () => {
  await page.evaluate(() => (location.hash = "#/settings"));
  const start = page.getByRole("button", { name: "Start check" });
  await expect(start).toBeVisible();
  await start.click();
  // The fake helper hears both sides from its first (100 ms) second, as "Fake Microphone" and
  // "Fake Speakers", and keeps going until Stop.
  const rows = page.getByRole("list", { name: "Microphone and Mac audio" });
  await expect(rows.locator('[data-side="mic"]')).toContainText("Fake Microphone");
  await expect(rows.locator('[data-side="system"]')).toContainText("Fake Speakers");
  await expect(rows.locator('[data-side="mic"]')).toContainText("Working", { timeout: 15_000 });
  await expect(rows.locator('[data-side="system"]')).toContainText("Working");
  await expect(page.getByRole("meter", { name: "Microphone level" })).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Check again" })).toBeEnabled({ timeout: 15_000 });
  await expect(page.getByRole("meter")).toHaveCount(0);
  await expect(rows.locator('[data-side="system"]')).toContainText("Working");
});

/** Records a backlog of more than 60 segments while the app can't be reached. Returns the
 * meeting's id and every seq the helper produced. */
async function recordOfflineBacklog(): Promise<{ meetingId: string; seqs: () => Promise<number[]> }> {
  await page.evaluate(() => (location.hash = "#/"));
  await expect(page.getByText("Coming up")).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as { __segs: number[]; everyapp: { on(c: string, f: (e: { event: string; seq?: number }) => void): () => void } };
    w.__segs = [];
    w.everyapp.on("helper", (e) => {
      if (e.event === "transcript.segment" && typeof e.seq === "number") w.__segs.push(e.seq);
    });
  });
  await page.keyboard.press("Meta+n");
  await page.waitForURL(/#\/meetings\//);
  await expect.poll(recordingState).toBe("recording");
  const meetingId = decodeURIComponent((await page.evaluate(() => location.hash)).split("/").pop() ?? "");
  const seqs = () => page.evaluate(() => [...(window as unknown as { __segs: number[] }).__segs]);
  await mock.setMode("offline");
  writeFileSync(burstFile, "");
  await expect.poll(async () => (await seqs()).length, { timeout: 15_000 }).toBeGreaterThan(60);
  rmSync(burstFile, { force: true });
  // Main noticed (the meeting page's own calls fail), so it will replay once the app is back.
  await expect.poll(connectionState, { timeout: 20_000 }).toBe("offline");
  return { meetingId, seqs };
}

/** Every segment POST (refused ones too) was ≤ 50, and /finish came after the last one. */
async function expectSavedInBatchesThenFinished(meetingId: string, produced: number[]) {
  await expect.poll(() => mock.segmentSeqs(meetingId), { timeout: 30_000 }).toEqual([...new Set(produced)].sort((a, b) => a - b));
  const log = await mock.log();
  const batches = log.segmentBatches.filter((b) => b.meetingId === meetingId);
  expect(batches.length).toBeGreaterThan(1);
  for (const b of batches) {
    expect(b.count, `a POST of ${b.count} segments`).toBeLessThanOrEqual(50);
    expect(b.refused).toBe(false);
  }
  await expect.poll(async () => (await mock.requests()).lastIndexOf(`POST /api/v1/meetings/${meetingId}/finish`), { timeout: 30_000 }).toBeGreaterThan(-1);
  const requests = await mock.requests();
  const lastSegments = requests.lastIndexOf(`POST /api/v1/meetings/${meetingId}/segments`);
  expect(requests.lastIndexOf(`POST /api/v1/meetings/${meetingId}/finish`)).toBeGreaterThan(lastSegments);
}

test("a backlog from an outage is saved in batches of ≤ 50 once the app is back, then finished", async () => {
  const { meetingId, seqs } = await recordOfflineBacklog();
  await mock.setMode("online");
  await expect.poll(connectionState, { timeout: 20_000 }).toBe("online");
  await page.getByRole("button", { name: /^Stop$/ }).click();
  await expect.poll(recordingState, { timeout: 30_000 }).toBe("idle");
  await expectSavedInBatchesThenFinished(meetingId, await seqs());
});

test("a stop while still offline hands the backlog to main, which replays it in batches when back", async () => {
  const { meetingId, seqs } = await recordOfflineBacklog();
  await page.getByRole("button", { name: /^Stop$/ }).click(); // still offline
  await expect.poll(recordingState, { timeout: 30_000 }).toBe("idle");
  const produced = await seqs();
  // Main kept the hand-back on disk, in the temp profile.
  expect(readdirSync(join(userData, "pending")).length).toBe(1);
  await mock.setMode("online");
  await expectSavedInBatchesThenFinished(meetingId, produced);
  await expect.poll(() => readdirSync(join(userData, "pending")).length, { timeout: 10_000 }).toBe(0);
});

test("shows the offline banner when the app can't be reached, and clears it after", async () => {
  await mock.setMode("offline");
  await page.evaluate(() => (location.hash = "#/"));
  await page.reload(); // any /api/v1 call notices
  const banner = page.getByText("Offline. Recording continues, and notes sync when you're back.");
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await mock.setMode("online");
  await expect(banner).toBeHidden({ timeout: 20_000 });
});

test("while recording offline, the notepad stays and keeps taking notes (Codex V3)", async () => {
  await page.evaluate(() => (location.hash = "#/"));
  await expect(page.getByText("Coming up")).toBeVisible();
  await page.keyboard.press("Meta+n");
  await page.waitForURL(/#\/meetings\//);
  const id = decodeURIComponent((await page.evaluate(() => location.hash)).split("/").pop() ?? "");
  const notepad = page.getByRole("textbox", { name: "Your notes" });
  await notepad.click();
  await page.keyboard.type("before the outage");
  await page.waitForTimeout(1200); // autosave
  await mock.setMode("offline");
  const banner = page.getByText("Offline. Recording continues, and notes sync when you're back.");
  await expect(banner).toBeVisible({ timeout: 20_000 });
  // The meeting refetches every 4 s while recording: a failed one must not replace the page.
  await page.waitForTimeout(5_000);
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await expect(notepad).toBeVisible();
  await notepad.click();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type("\nduring the outage");
  await expect(notepad).toHaveValue(/before the outage[\s\S]*during the outage/);
  await mock.setMode("online");
  await expect(banner).toBeHidden({ timeout: 20_000 });
  // What was typed offline reaches the server once it's back.
  await expect
    .poll(
      async () => {
        const res = await fetch(`${mock.url}/api/v1/meetings/${encodeURIComponent(id)}`, { headers: { authorization: "Bearer e2e" } });
        const body = (await res.json()) as { meeting?: { jottings: { markdown: string } | null } };
        return body.meeting?.jottings?.markdown ?? "";
      },
      { timeout: 20_000 },
    )
    .toMatch(/during the outage/);
  await page.getByRole("button", { name: /^Stop$/ }).click();
  await expect(page.getByRole("button", { name: /^Stop$/ })).toBeHidden({ timeout: 30_000 });
});

test("shows the sign-in-again prompt, in place, when the token is refused", async () => {
  await page.evaluate(() => (location.hash = "#/settings"));
  await expect(page.getByRole("switch", { name: "Ask to record calls" })).toBeVisible();
  await mock.setMode("unauthorized");
  await page.evaluate(() => (location.hash = "#/"));
  // A token sign-in asks for a new token (an OAuth one shows "Sign in again"); the page stays.
  await expect(page.getByLabel("New access token")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Coming up")).toBeVisible();
  // Signing in again with a working token clears it.
  await mock.setMode("online");
  await page.getByLabel("New access token").fill("e2e-token-2");
  await page.getByRole("button", { name: /^Sign in$/ }).click();
  await expect(page.getByLabel("New access token")).toBeHidden({ timeout: 15_000 });
});

test("an update that downloaded is offered, and waits for the recording to end", async () => {
  type Snap = { updater: { state: string; version?: string; deferred?: boolean }; recording: { state: string } };
  const snap = () => page.evaluate(() => (window as unknown as { everyapp: { "state:get"(): Promise<unknown> } }).everyapp["state:get"]()) as Promise<Snap>;
  await expect.poll(async () => (await snap()).updater).toMatchObject({ state: "ready", version: "9.9.9" });
  // The window's quiet pill in the sidebar footer (#43).
  const pill = page.getByRole("status", { name: "Update" });
  await expect(pill).toContainText("Update ready · 9.9.9");
  await expect(pill.getByRole("button", { name: "Restart" })).toBeVisible();
  const menuLabels = () =>
    app.evaluate(({ Menu }) => {
      const out: string[] = [];
      const walk = (items: Electron.MenuItem[]) => items.forEach((i) => (out.push(i.label), i.submenu && walk(i.submenu.items)));
      walk(Menu.getApplicationMenu()?.items ?? []);
      return out;
    });
  expect(await menuLabels()).toContain("Restart to Update (9.9.9)");
  expect(await menuLabels()).toContain("Check for Updates…"); // always in the menu, feed or not
  // During a recording, asking to restart defers it; Stop offers it again.
  await page.evaluate(() => (location.hash = "#/"));
  await page.keyboard.press("Meta+n");
  await page.waitForURL(/#\/meetings\//);
  await expect.poll(async () => (await snap()).recording.state).toBe("recording");
  await expect(pill).toBeHidden(); // never while recording
  expect(await menuLabels()).toContain("Restart to Update (9.9.9) after this recording");
  const result = await page.evaluate(() => (window as unknown as { everyapp: { "update:install"(): Promise<{ deferred: boolean }> } }).everyapp["update:install"]());
  expect(result).toEqual({ deferred: true });
  expect((await snap()).updater.deferred).toBe(true);
  await page.getByRole("button", { name: /^Stop$/ }).click();
  await expect.poll(async () => (await snap()).updater.deferred).toBe(false);
  expect(await menuLabels()).toContain("Restart to Update (9.9.9)");
  // After Stop, the pill offers the restart that was put off.
  await expect(pill).toContainText("Restart to update", { timeout: 15_000 });
});

test("Help → Reset Onboarding (dev builds) shows first run again", async () => {
  const clicked = await app.evaluate(({ Menu }) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const i of items) {
        if (i.label === "Reset Onboarding") return i;
        const inner = i.submenu && find(i.submenu.items);
        if (inner) return inner;
      }
      return undefined;
    };
    const item = find(Menu.getApplicationMenu()?.items ?? []);
    item?.click();
    return !!item;
  });
  expect(clicked).toBe(true);
  await expect(page.getByRole("button", { name: "Continue" })).toBeVisible({ timeout: 15_000 });
  // Only the flag went: still signed in, settings kept.
  expect(JSON.parse(readFileSync(join(userData, "settings.json"), "utf8"))).toBeTruthy();
  await page.evaluate(() => {
    localStorage.setItem("everyapp.onboarded", "1");
    location.hash = "#/";
  });
  await page.reload();
  await expect(page.getByText("Coming up")).toBeVisible();
});
