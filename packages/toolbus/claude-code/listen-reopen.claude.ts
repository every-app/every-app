/**
 * Claude Code against the ToolBus's held `subscriptions/listen` stream,
 * measured with a real `claude -p` (needs the `claude` CLI logged in; spends
 * a few cents per phase; not run in CI). It answers the question behind the
 * gateway surface's hold (`LISTEN_MAX_MS` in ../src/http.ts): how long may
 * a stream be held before Claude Code stops reopening it?
 *
 * Claude Code 2.1.309 (read from its binary, 2026-10-24) keeps the times of
 * its reopens in a trailing one-hour window; once five are in it, the next
 * reopen is parked for about six hours, and until then it keeps the tools
 * it last fetched. A stream that lived under ten seconds escalates a
 * 1 s / 2 s / 4 s backoff instead, and three reopens that fail in a row
 * stop re-listening for the connection. After a graceful close (the hold
 * ending with a `complete` result) it reopens about six seconds later and
 * refetches `tools/list`; a `list_changed` on the stream makes it refetch
 * within milliseconds, which is how this harness tells hearing from deaf.
 *
 * Phases (LISTEN_PHASE, default `smoke`):
 *
 *   smoke  a 20 s hold: one reopen and one change heard; checks the harness
 *          (about two minutes).
 *   today  the ten-minute hold scaled to 60 s: five reopens, then the sixth
 *          close parks re-listen and a change is no longer heard (about
 *          nine minutes). What a connected Claude Code met with the old
 *          constant after fifty minutes.
 *   fixed  the gateway surface's hold as shipped, in real time: still
 *          listening and hearing changes past ninety minutes, three reopens
 *          in, with the trailing hour never reaching five (about 95
 *          minutes).
 *
 *   LISTEN_PHASE=today pnpm -C packages/toolbus test:claude-code
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GATEWAY_LISTEN_MAX_MS } from "../src/http";
import { startHarnessServer, type HarnessServer } from "./server";

const PHASE = process.env["LISTEN_PHASE"] ?? "smoke";
const MODEL = process.env["LISTEN_MODEL"] ?? "sonnet";
const MINUTE = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  what: string,
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return;
    await sleep(250);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
}

/** A `claude -p` session kept alive on a stream-json stdin. */
class ClaudeSession {
  readonly events: unknown[] = [];
  readonly log: string[] = [];
  private child: ChildProcess;
  private exited: Promise<number | null>;

  /** Claude Code's own debug log (`--debug-file`): the reopen decisions. */
  readonly debugFile: string;

  constructor(mcpUrl: string, cwd: string) {
    this.debugFile = join(cwd, "claude-debug.log");
    this.child = spawn(
      "claude",
      [
        "-p",
        "--model",
        MODEL,
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--verbose",
        "--debug",
        "mcp",
        "--debug-file",
        this.debugFile,
        "--max-turns",
        "6",
        "--dangerously-skip-permissions",
        "--strict-mcp-config",
        "--mcp-config",
        JSON.stringify({
          mcpServers: { everyapp: { type: "http", url: mcpUrl } },
        }),
      ],
      {
        cwd,
        env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let out = "";
    this.child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const lines = out.split("\n");
      out = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        this.log.push(`${stamp()} stdout ${line.slice(0, 400)}`);
        try {
          this.events.push(JSON.parse(line));
        } catch {
          // Not JSON: logged above.
        }
      }
    });
    this.child.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim())
          this.log.push(`${stamp()} stderr ${line.slice(0, 400)}`);
      }
    });
    this.exited = new Promise((resolve) =>
      this.child.on("exit", (code) => resolve(code)),
    );
  }

  send(text: string): void {
    this.child.stdin?.write(
      `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`,
    );
  }

  /** The text of the assistant's answers so far. */
  answers(): string {
    return this.events
      .flatMap((event) => {
        const message = (
          event as { type?: string; message?: { content?: unknown } }
        ).message;
        if ((event as { type?: string }).type !== "assistant") return [];
        const content = message?.content;
        return Array.isArray(content)
          ? content.flatMap((part) =>
              typeof part?.text === "string" ? [part.text as string] : [],
            )
          : [];
      })
      .join("\n");
  }

  async close(): Promise<number | null> {
    this.child.stdin?.end();
    const code = await Promise.race([
      this.exited,
      sleep(20_000).then(() => null),
    ]);
    if (code === null && this.child.exitCode === null)
      this.child.kill("SIGTERM");
    return code;
  }
}

function stamp(): string {
  return new Date().toISOString().slice(11, 23);
}

let server: HarnessServer | undefined;
let session: ClaudeSession | undefined;

/** The harness's own timeline, for the report. */
function timeline(server: HarnessServer, startedAt: number): string {
  const lines = server.requests.map(
    (request) =>
      `${((request.at - startedAt) / 1000).toFixed(1).padStart(8)} s  ${request.method.padEnd(22)} ${request.kind} ${request.status}`,
  );
  const streams = server.streams.map(
    (stream, index) =>
      `stream ${index + 1}: opened +${((stream.openedAt - startedAt) / 1000).toFixed(1)} s, ` +
      (stream.closedAt
        ? `closed +${((stream.closedAt - startedAt) / 1000).toFixed(1)} s (lived ${((stream.closedAt - stream.openedAt) / 1000).toFixed(1)} s)`
        : "still open") +
      `, pushed: ${stream.pushed.join(" ") || "(nothing)"}`,
  );
  return [...lines, "", ...streams].join("\n");
}

async function report(name: string, startedAt: number): Promise<string> {
  let debug = "";
  try {
    debug = await readFile(session!.debugFile, "utf8");
  } catch {
    debug = "(no debug log)";
  }
  const text = [
    `# ${name} (${new Date(startedAt).toISOString()})`,
    "",
    "## ToolBus requests",
    timeline(server!, startedAt),
    "",
    "## Claude Code's MCP debug log (listen lines)",
    ...debug
      .split("\n")
      .filter((line) => /listen|list_changed|tools/.test(line)),
    "",
    "## Claude Code's output",
    ...(session?.log ?? []),
  ].join("\n");
  const dir = process.env["LISTEN_REPORT_DIR"] ?? tmpdir();
  const file = join(dir, `listen-${name}-${startedAt}.log`);
  await writeFile(file, text);
  console.log(`report: ${file}`);
  return text;
}

/** `tools/list` requests after `since`. */
function listsAfter(since: number): number {
  return server!.requests.filter(
    (request) => request.method === "tools/list" && request.at > since,
  ).length;
}

/** Listen streams opened after `since`. */
function opensAfter(since: number): number {
  return server!.streams.filter((stream) => stream.openedAt > since).length;
}

async function start(listenMaxMs: number, listenPollMs: number) {
  server = await startHarnessServer({ listenMaxMs, listenPollMs });
  const cwd = await mkdtemp(join(tmpdir(), "listen-reopen-"));
  session = new ClaudeSession(server.url, cwd);
  const startedAt = Date.now();
  session.send("Reply with the single word OK and nothing else.");
  // Claude Code connects at session start: discover, listen, tools/list.
  await waitFor(
    "the first held listen stream",
    () => server!.streams.length >= 1,
    90_000,
  );
  await waitFor("the first tools/list", () => listsAfter(0) >= 1, 30_000);
  return startedAt;
}

/** Push a change and wait for Claude Code's `tools/list` refetch. */
async function heard(name: string, pollMs: number): Promise<boolean> {
  const before = Date.now();
  server!.addTool(name);
  try {
    await waitFor(
      `tools/list after ${name}`,
      () => listsAfter(before) >= 1,
      pollMs + 5_000,
    );
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await session?.close();
  await server?.close();
  session = undefined;
  server = undefined;
});

describe.runIf(PHASE === "smoke")("smoke: a 20 s hold", () => {
  it(
    "reopens after the hold ends and hears a change on the new stream",
    async () => {
      const startedAt = await start(20_000, 5_000);
      expect(await heard("add_note", 5_000)).toBe(true);
      await waitFor("a reopen", () => server!.streams.length >= 2, 60_000);
      expect(await heard("archive_note", 5_000)).toBe(true);
      const text = await report("smoke", startedAt);
      expect(text).toContain("notifications/tools/list_changed");
    },
    4 * MINUTE,
  );
});

describe.runIf(PHASE === "today")(
  "today: the ten-minute hold, scaled to 60 s",
  () => {
    it(
      "goes deaf after the fifth reopen in the trailing hour",
      async () => {
        const startedAt = await start(60_000, 5_000);
        expect(await heard("add_note", 5_000)).toBe(true);
        // Five graceful ends, five reopens: streams 2..6.
        await waitFor(
          "six streams",
          () => server!.streams.length >= 6,
          8 * MINUTE,
        );
        expect(await heard("archive_note", 5_000)).toBe(true);
        // The sixth stream's end is the sixth close: five reopens are in the
        // trailing hour, so Claude Code parks re-listen.
        await waitFor(
          "the sixth stream to end",
          () => server!.streams[5]?.closedAt !== undefined,
          2 * MINUTE,
        );
        const parkedAt = server!.streams[5]!.closedAt!;
        await sleep(45_000);
        const reopened = opensAfter(parkedAt);
        const stillHeard = await heard("pin_note", 5_000);
        const text = await report("today", startedAt);
        expect(text).toContain("parking re-listen");
        expect(reopened).toBe(0);
        expect(stillHeard).toBe(false);
      },
      15 * MINUTE,
    );
  },
);

describe.runIf(PHASE === "fixed")(
  `fixed: the gateway surface's hold (${GATEWAY_LISTEN_MAX_MS / MINUTE} minutes), in real time`,
  () => {
    it(
      "keeps reopening and hearing changes past ninety minutes",
      async () => {
        const startedAt = await start(GATEWAY_LISTEN_MAX_MS, 30_000);
        expect(await heard("add_note", 30_000)).toBe(true);
        const checkpoints = [1, 2, 3];
        for (const count of checkpoints) {
          await waitFor(
            `reopen ${count}`,
            () => server!.streams.length >= count + 1,
            GATEWAY_LISTEN_MAX_MS + 2 * MINUTE,
          );
          console.log(
            `${stamp()} reopen ${count} at +${((server!.streams[count]!.openedAt - startedAt) / MINUTE).toFixed(1)} min`,
          );
          expect(await heard(`note_${count}`, 30_000)).toBe(true);
        }
        // Past ninety minutes with three reopens in: the trailing hour holds
        // at most two, so the next close is not parked either.
        await sleep(Math.max(0, startedAt + 92 * MINUTE - Date.now()));
        const stillOpen = server!.streams.at(-1)?.closedAt === undefined;
        const stillHeard = await heard("note_final", 30_000);
        session!.send(
          "Call the everyapp_list_apps tool and reply with the number of tools the notes app offers, as a bare number.",
        );
        await waitFor(
          "the final answer",
          () => /\b[0-9]+\b/.test(session!.answers().split("OK").pop() ?? ""),
          3 * MINUTE,
        );
        const text = await report("fixed", startedAt);
        expect(text).not.toContain("parking re-listen");
        expect(text).not.toContain("giving up on re-listen");
        expect(stillOpen || opensAfter(startedAt + 90 * MINUTE) >= 1).toBe(
          true,
        );
        expect(stillHeard).toBe(true);
        expect(server!.streams.length).toBeGreaterThanOrEqual(4);
      },
      110 * MINUTE,
    );
  },
);
