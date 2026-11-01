import { describe, expect, it } from "vitest";
import { createScriptedUser } from "./scriptedUser";
import { FakeSandbox, type FakeExecCall } from "./sandbox";
import { runHarnessTurns, TOKEN_BUDGET, type TurnsDeps } from "./turns";
import type { HarnessAdapter, NormalizedEvent } from "./types";

const ZONE = "everyapp-loop1.com";
const AT = "2026-10-25T14:00:00.000Z";

/** A harness whose stream is `TEXT <text>` lines and a final `RESULT` line, resumed with `--resume <id>`. */
function fakeAdapter(): HarnessAdapter {
  return {
    name: "claude",
    version: "x",
    status: "measured",
    providerVar: "ANTHROPIC_API_KEY",
    defaultModel: "m",
    signal: {
      toolCalls: "full",
      toolOutput: "full",
      exitCodes: true,
      cost: "harness",
      resume: "native",
    },
    permissionBypass: true,
    command: () => ({ argv: ["fake", "--turn", "1"], env: { X: "1" } }),
    resume: (sessionId, replyPath) =>
      sessionId ? { argv: ["fake", "--resume", sessionId, replyPath] } : null,
    normalize: (line, _stream, receivedAt): NormalizedEvent[] => {
      if (line.startsWith("TEXT "))
        return [
          {
            receivedAt,
            kind: "assistant_text",
            text: line.slice(5),
            sessionId: "s1",
            raw: line,
          },
        ];
      if (line.startsWith("TOKENS "))
        return [
          {
            receivedAt,
            kind: "turn_end",
            tokens: { input: Number(line.slice(7)), output: 0 },
            raw: line,
          },
        ];
      if (line === "RESULT")
        return [
          { receivedAt, kind: "result", text: "", sessionId: "s1", raw: line },
        ];
      return [];
    },
    collectPaths: [],
    fixture: null,
  };
}

function world(
  script: (
    call: FakeExecCall,
    turn: number,
  ) => { stdout?: string[]; code?: number; hang?: boolean } | undefined,
  overrides: Partial<TurnsDeps> = {},
) {
  let turn = 0;
  const sandbox = new FakeSandbox((call) => {
    turn += 1;
    return script(call, turn);
  });
  const user = createScriptedUser({
    zone: ZONE,
    accountName: "loop-1",
    withAccess: false,
  });
  const replies: string[] = [];
  const queued: string[] = [];
  const events: Array<[number, NormalizedEvent]> = [];
  const deps: TurnsDeps = {
    sandbox,
    handle: { id: "c", name: "loop-c" },
    adapter: fakeAdapter(),
    launch: { promptPath: "/loop/prompt.txt", zone: ZONE, loopDir: "/loop" },
    user,
    cwd: "/work/every-app",
    writeReply: async (index, text) => {
      replies.push(text);
      return `/loop/reply-${index}.txt`;
    },
    takeQueuedReplies: async () => queued.splice(0),
    onEvent: (event, processIndex) => events.push([processIndex, event]),
    deadlineAt: Date.now() + 60_000,
    sleep: async () => undefined,
    ...overrides,
  };
  return { sandbox, user, replies, queued, events, deps };
}

describe("runHarnessTurns", () => {
  it("stops on DONE after one process and records the command line", async () => {
    const w = world(() => ({
      stdout: [
        "TEXT Everything is up. DONE https://apps.everyapp-loop1.com",
        "RESULT",
      ],
    }));
    const result = await runHarnessTurns(w.deps);
    expect(result.terminal).toBe("done");
    expect(result.processes).toHaveLength(1);
    expect(result.resumes).toEqual([]);
    expect(result.sessionId).toBe("s1");
    expect(result.commandArgv).toEqual(["fake", "--turn", "1"]);
    expect(w.user.state.done).toEqual({
      url: "https://apps.everyapp-loop1.com",
    });
    expect(w.sandbox.execs[0]?.options.env).toEqual({ X: "1" });
    expect(w.sandbox.execs[0]?.options.cwd).toBe("/work/every-app");
    expect(w.events.map(([i, e]) => [i, e.kind])).toEqual([
      [0, "assistant_text"],
      [0, "result"],
    ]);
  });

  it("answers the domain question asked mid-turn when the turn ends, through the native resume, as an expected hand-off", async () => {
    const w = world((_call, turn) =>
      turn === 1
        ? { stdout: ["TEXT Which domain should I use?", "RESULT"] }
        : { stdout: ["TEXT DONE https://apps.everyapp-loop1.com", "RESULT"] },
    );
    const result = await runHarnessTurns(w.deps);
    expect(result.terminal).toBe("done");
    expect(w.replies).toEqual([`My domain is ${ZONE}`]);
    expect(w.sandbox.execs[1]?.argv).toEqual([
      "fake",
      "--resume",
      "s1",
      "/loop/reply-1.txt",
    ]);
    expect(result.resumes).toHaveLength(1);
    expect(result.resumes[0]).toMatchObject({
      reason: "turn_end_without_done",
      how: "native",
      sessionId: "s1",
    });
    expect(w.user.state.interventions).toEqual([]);
    expect(w.user.state.turns.map((t) => [t.trigger, t.expected])).toEqual([
      ["domain_question", true],
    ]);
  });

  it("a turn that ends without DONE gets the universal reply (an intervention), up to the cap, then caps_exceeded", async () => {
    const w = world(() => ({ stdout: ["TEXT I did some things.", "RESULT"] }));
    const result = await runHarnessTurns(w.deps);
    expect(result.terminal).toBe("caps_exceeded");
    expect(w.replies).toHaveLength(3);
    expect(w.replies[0]).toContain(`My domain is ${ZONE}`);
    expect(result.processes).toHaveLength(4);
    expect(w.user.state.interventions.map((i) => i.kind)).toEqual([
      "nudge",
      "nudge",
      "nudge",
    ]);
  });

  it("a process that exits without a result event is resumed as harness_exit, twice", async () => {
    const w = world(() => ({ stdout: ["TEXT working..."], code: 1 }));
    const result = await runHarnessTurns(w.deps);
    expect(result.terminal).toBe("caps_exceeded");
    expect(result.resumes.map((r) => r.reason)).toEqual([
      "harness_exit",
      "harness_exit",
    ]);
    expect(result.exits.map((e) => e.exitCode)).toEqual([1, 1, 1]);
  });

  it("holds the reply while a setup is still running in the event log, then asks again", async () => {
    let asked = 0;
    const w = world((_call, turn) =>
      turn === 1
        ? { stdout: ["TEXT setup is running in the background", "RESULT"] }
        : { stdout: ["TEXT DONE https://apps.everyapp-loop1.com", "RESULT"] },
    );
    w.user.onInput({ kind: "setup_started" });
    const sleep = async () => {
      asked += 1;
      // The setup ends after the first poll: the planned turn 2 asks for the app.
      w.user.onInput({ kind: "setup_ended", status: "done" });
    };
    const result = await runHarnessTurns({ ...w.deps, sleep });
    expect(asked).toBe(1);
    expect(result.terminal).toBe("done");
    expect(w.replies[0]).toContain("create hello");
    expect(w.user.state.turns[0]).toMatchObject({
      trigger: "create_app",
      expected: true,
    });
  });

  it("a reply the driver queued from the event log (Done, continue after the subdomain PUT) goes out at the turn end, no nudge counted", async () => {
    const w = world((_call, turn) =>
      turn === 1
        ? {
            stdout: [
              "TEXT setup stopped: register a workers.dev name",
              "RESULT",
            ],
          }
        : { stdout: ["TEXT DONE https://apps.everyapp-loop1.com", "RESULT"] },
    );
    const action = w.user.onInput({
      kind: "action_required",
      action: "register_workers_subdomain",
      data: {},
    });
    expect(action).toMatchObject({
      type: "register_workers_subdomain",
      subdomain: "everyapp-loop1",
      thenReply: "Done, continue",
    });
    w.queued.push("Done, continue");
    const result = await runHarnessTurns(w.deps);
    expect(w.replies).toEqual(["Done, continue"]);
    expect(result.terminal).toBe("done");
    expect(result.resumes[0]?.reason).toBe("turn_end_without_done");
    expect(w.user.state.interventions).toEqual([]);
    expect(w.user.state.exercised).toContain("register_workers_subdomain");
  });

  it("a fixture action stops the run as fixture_error without a reply", async () => {
    const w = world(() => ({
      stdout: ["TEXT stopped for the person", "RESULT"],
    }));
    w.user.onInput({
      kind: "action_required",
      action: "cloudflare_login",
      data: {},
    });
    const result = await runHarnessTurns(w.deps);
    expect(result).toMatchObject({
      terminal: "fixture_error",
      fixtureCode: "cloudflare_login",
    });
    expect(w.replies).toEqual([]);
  });

  it("a person's queued answer goes out at the turn end as an intervention by a person", async () => {
    const answers = ["Use the token in CLOUDFLARE_API_TOKEN"];
    const w = world((_call, turn) =>
      turn === 1
        ? { stdout: ["TEXT How do I log in?", "RESULT"] }
        : { stdout: ["TEXT DONE https://apps.everyapp-loop1.com", "RESULT"] },
    );
    const result = await runHarnessTurns({
      ...w.deps,
      takePersonAnswer: () => answers.shift() ?? null,
    });
    expect(result.terminal).toBe("done");
    expect(w.replies).toEqual(["Use the token in CLOUDFLARE_API_TOKEN"]);
    expect(result.resumes[0]?.reason).toBe("person");
    expect(w.user.state.interventions[0]).toMatchObject({
      kind: "person_answer",
      source: "person",
    });
  });

  it("the deadline ends the run as time_cap; a token ceiling kills a harness without a budget flag", async () => {
    const late = world(() => ({ stdout: ["TEXT hi", "RESULT"] }), {
      deadlineAt: Date.now() - 1,
    });
    expect((await runHarnessTurns(late.deps)).terminal).toBe("time_cap");
    const hung = world(() => ({ hang: true }), { deadlineAt: Date.now() + 20 });
    expect((await runHarnessTurns(hung.deps)).terminal).toBe("time_cap");
    const greedy = world(() => ({
      stdout: [`TOKENS ${TOKEN_BUDGET + 1}`, "TEXT still going", "RESULT"],
    }));
    greedy.deps.adapter.signal.cost = "tokens_x_list";
    const result = await runHarnessTurns(greedy.deps);
    expect(result.terminal).toBe("budget");
    const budgeted = world(() => ({
      stdout: [
        `TOKENS ${TOKEN_BUDGET + 1}`,
        "TEXT DONE https://apps.everyapp-loop1.com",
        "RESULT",
      ],
    }));
    expect((await runHarnessTurns(budgeted.deps)).terminal).toBe("done");
  });

  it("a stream with no closing event that exits 0 (opencode run ends on its last text) is a turn end, not a crash: the planned hand-off, no intervention", async () => {
    const w = world((_call, turn) =>
      turn === 1
        ? { stdout: ["TEXT Setup is done; waiting for you."], code: 0 }
        : { stdout: ["TEXT DONE https://apps.everyapp-loop1.com", "RESULT"] },
    );
    // The adapter synthesizes the result at exit, as opencode's and the script's do.
    w.deps.adapter.onExit = (exitCode, receivedAt) => [
      {
        receivedAt,
        kind: "result",
        text: "Setup is done; waiting for you.",
        sessionId: "s1",
        raw: { synthesized: "process_exit", exitCode },
      },
    ];
    w.user.onInput({ kind: "setup_started" });
    w.user.onInput({ kind: "setup_ended", status: "done" });
    const result = await runHarnessTurns(w.deps);
    expect(result.terminal).toBe("done");
    expect(result.resumes.map((r) => r.reason)).toEqual([
      "turn_end_without_done",
    ]);
    expect(w.user.state.turns[0]).toMatchObject({
      trigger: "create_app",
      expected: true,
    });
    expect(w.user.state.interventions).toEqual([]);
  });

  it("while a reply is held for a running setup, each poll asks the driver; a setup found dead ends the wait at once", async () => {
    let polls = 0;
    const w = world((_call, turn) =>
      turn === 1
        ? { stdout: ["TEXT setup is running in the background", "RESULT"] }
        : { stdout: ["TEXT DONE https://apps.everyapp-loop1.com", "RESULT"] },
    );
    w.user.onInput({ kind: "setup_started" });
    const result = await runHarnessTurns({
      ...w.deps,
      onWaitPoll: async () => {
        polls += 1;
        // `kill -0 <pid>` failed: the harness killed its background task; no exit line will come.
        w.user.onInput({ kind: "setup_ended", status: "killed" });
      },
    });
    expect(polls).toBe(1);
    expect(result.terminal).toBe("done");
    expect(w.replies).toHaveLength(1);
  });

  it("calls onTurnEnd after each process exits and before the scripted user decides", async () => {
    const order: string[] = [];
    const w = world((_call, turn) => {
      order.push(`exec ${turn}`);
      return turn === 1
        ? { stdout: ["TEXT Which domain should I use?", "RESULT"] }
        : { stdout: ["TEXT DONE https://apps.everyapp-loop1.com", "RESULT"] };
    });
    await runHarnessTurns({
      ...w.deps,
      onTurnEnd: async () => {
        order.push(`turn end ${w.user.state.turns.length}`);
      },
    });
    expect(order).toEqual(["exec 1", "turn end 0", "exec 2", "turn end 1"]);
  });

  it("a harness with no resume (the control script) ends as no_resume when a reply is due", async () => {
    const w = world(() => ({ stdout: ["TEXT not done", "RESULT"] }));
    w.deps.adapter.resume = () => null;
    expect((await runHarnessTurns(w.deps)).terminal).toBe("no_resume");
  });
});
