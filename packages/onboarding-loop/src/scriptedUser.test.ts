import { describe, expect, it } from "vitest";
import {
  CAPS,
  CREATE_APP_REPLY,
  createScriptedUser,
  domainReply,
  EXPECTED_HANDOFFS,
  FIXTURE_ACTIONS,
  NO_ACCESS_REPLY,
  isDomainQuestion,
  isEarlyAdopterQuestion,
  isFourAppsQuestion,
  FOUR_APPS_REPLY,
  EARLY_ADOPTER_REPLY,
  parseBlocked,
  parseDone,
  subdomainFor,
  universalReply,
} from "./scriptedUser";

const zone = "everyapp-loop1.com";
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 9, 25, 14, 0, tick++));
const user = (
  overrides: Partial<Parameters<typeof createScriptedUser>[0]> = {},
) =>
  createScriptedUser({
    zone,
    accountName: "loop-1",
    withAccess: false,
    now: clock,
    ...overrides,
  });

describe("the reply table", () => {
  const notice =
    "EveryApp is in early development so expect some rough edges. Here's a link with more details about giving feedback: https://everyapp.com/docs/early-adopters\nDo you still want to get set up or would you rather wait a few weeks?";
  it("answers the early-adopter notice (#762) as an expected hand-off, not a nudge", () => {
    const u = user();
    const action = u.onInput({
      kind: "turn_end",
      text: notice,
      hadResultEvent: true,
    });
    expect(action).toEqual({
      type: "reply",
      trigger: "early_adopter_question",
      text: EARLY_ADOPTER_REPLY,
      expected: true,
    });
    expect(u.state.interventions).toHaveLength(0);
    expect(u.state.nudges).toBe(0);
    // Then the domain question, answered as before.
    expect(
      u.onInput({
        kind: "turn_end",
        text: "Which domain should I use?",
        hadResultEvent: true,
      }),
    ).toMatchObject({ trigger: "domain_question", expected: true });
    expect(u.state.exercised).toEqual([
      "early_adopter_question",
      "domain_question",
    ]);
  });
  it("answers the notice and the domain in one reply when both are asked at once", () => {
    const u = user();
    const action = u.onInput({
      kind: "turn_end",
      text: `${notice}\nIf you want to go ahead, which domain should I use?`,
      hadResultEvent: true,
    });
    expect(action).toEqual({
      type: "reply",
      trigger: "domain_question",
      text: `${EARLY_ADOPTER_REPLY} ${domainReply(zone)}`,
      expected: true,
    });
    expect(u.state.exercised).toEqual([
      "early_adopter_question",
      "domain_question",
    ]);
  });
  it("answers the notice when the agent wraps it in BLOCKED:", () => {
    const u = user();
    expect(
      u.onInput({
        kind: "turn_end",
        text: `BLOCKED: waiting for your answer. ${notice}`,
        hadResultEvent: true,
      }),
    ).toMatchObject({ trigger: "early_adopter_question" });
  });
  it("answers step 4's four-apps question as an expected hand-off once the app is live (launch gate run 1)", () => {
    const u = user();
    u.onInput({ kind: "setup_ended", status: "done" });
    u.onInput({ kind: "app_deployed" });
    const action = u.onInput({
      kind: "turn_end",
      text: "`hello` is live at https://hello.apps.example.com.\n\nI'll install OpenSEO, OpenCRM, OpenAnalytics and OpenMail. Any you don't want?",
      hadResultEvent: true,
    });
    expect(action).toEqual({
      type: "reply",
      trigger: "four_apps_question",
      text: FOUR_APPS_REPLY,
      expected: true,
    });
    expect(u.state.interventions).toHaveLength(0);
    expect(isFourAppsQuestion("Next I'll ask you which ones to skip.")).toBe(
      false,
    );
    expect(isFourAppsQuestion("Which should I skip?")).toBe(true);
  });
  it("tells the question from narration about it", () => {
    expect(isEarlyAdopterQuestion(notice)).toBe(true);
    expect(
      isEarlyAdopterQuestion(
        '"Do you still want to get set up or would you rather wait a few weeks?"',
      ),
    ).toBe(true);
    expect(
      isEarlyAdopterQuestion(
        "First I will ask you whether you'd rather wait a few weeks.",
      ),
    ).toBe(false);
  });
  it("answers the domain question with the zone, never apps.<zone>", () => {
    const u = user();
    // Mid-turn text is narration; the question counts when the turn ends on it.
    expect(
      u.onInput({
        kind: "assistant_text",
        text: "Which domain should I use for the Gateway?",
      }),
    ).toBeNull();
    const action = u.onInput({
      kind: "turn_end",
      text: "Which domain should I use for the Gateway?",
      hadResultEvent: true,
    });
    expect(action).toEqual({
      type: "reply",
      trigger: "domain_question",
      text: `My domain is ${zone}`,
      expected: true,
    });
    expect(domainReply(zone)).not.toContain("apps.");
    expect(u.state.turns).toHaveLength(1);
    expect(u.state.interventions).toHaveLength(0);
    expect(u.state.exercised).toEqual(["domain_question"]);
  });
  it("counts the same hand-off answered twice as a repeated_answer intervention", () => {
    const u = user();
    u.onInput({
      kind: "turn_end",
      text: "What domain do you want?",
      hadResultEvent: true,
    });
    const second = u.onInput({
      kind: "turn_end",
      text: "Which domain should I use?",
      hadResultEvent: true,
    });
    expect(second).toMatchObject({ type: "reply", expected: false });
    expect(u.state.interventions.map((i) => i.kind)).toEqual([
      "repeated_answer",
    ]);
  });
  it("registers the workers.dev name by REST, then says Done, continue", () => {
    const u = user();
    const action = u.onInput({
      kind: "action_required",
      action: "register_workers_subdomain",
      data: {},
    });
    expect(action).toEqual({
      type: "register_workers_subdomain",
      subdomain: "everyapp-loop1",
      thenReply: "Done, continue",
    });
    expect(subdomainFor("loop-2")).toBe("everyapp-loop2");
    expect(u.state.exercised).toContain("register_workers_subdomain");
  });
  it("leaves claim_owner to the claimer but counts it exercised", () => {
    const u = user();
    expect(
      u.onInput({
        kind: "action_required",
        action: "claim_owner",
        data: { url: "https://x/setup#token=est_a" },
      }),
    ).toBeNull();
    expect(u.state.exercised).toEqual(["claim_owner"]);
  });
  it("answers ACCESS_TEAM_REQUIRED with a team under --with-access, else by leaving Access off", () => {
    expect(
      user().onInput({ kind: "cli_error", code: "ACCESS_TEAM_REQUIRED" }),
    ).toMatchObject({
      type: "reply",
      trigger: "ACCESS_TEAM_REQUIRED",
      text: NO_ACCESS_REPLY,
    });
    expect(
      user({ withAccess: true }).onInput({
        kind: "cli_error",
        code: "ACCESS_TEAM_REQUIRED",
      }),
    ).toMatchObject({
      type: "reply",
      trigger: "ACCESS_TEAM_REQUIRED",
      text: "Use --team everyapp-loop1",
      expected: true,
    });
  });
  it("never answers a fixture action: the run is fail-infra", () => {
    for (const code of FIXTURE_ACTIONS) {
      const u = user();
      const action =
        code === "CLOUDFLARE_TOKEN_REJECTED"
          ? u.onInput({ kind: "cli_error", code })
          : u.onInput({ kind: "action_required", action: code, data: {} });
      expect(action).toEqual({ type: "fixture_error", code });
      // Everything after is the same answer.
      expect(
        u.onInput({ kind: "assistant_text", text: "which domain?" }),
      ).toEqual({ type: "fixture_error", code });
    }
  });
  it("treats DOMAIN_REQUIRED after the domain was given as a fixture error", () => {
    const u = user();
    expect(
      u.onInput({ kind: "cli_error", code: "DOMAIN_REQUIRED" }),
    ).toBeNull();
    u.onInput({
      kind: "turn_end",
      text: "Which domain?",
      hadResultEvent: true,
    });
    expect(u.onInput({ kind: "cli_error", code: "DOMAIN_REQUIRED" })).toEqual({
      type: "fixture_error",
      code: "DOMAIN_REQUIRED_AFTER_ANSWER",
    });
  });
});

describe("turn ends", () => {
  it("stops on DONE and on BLOCKED", () => {
    const done = user();
    expect(
      done.onInput({
        kind: "turn_end",
        text: "All set.\nDONE https://apps.everyapp-loop1.com",
        hadResultEvent: true,
      }),
    ).toEqual({ type: "stop", reason: "done" });
    expect(done.state.done).toEqual({ url: "https://apps.everyapp-loop1.com" });
    const blocked = user();
    expect(
      blocked.onInput({
        kind: "turn_end",
        text: "BLOCKED: no Cloudflare token",
        hadResultEvent: true,
      }),
    ).toEqual({ type: "stop", reason: "blocked" });
    expect(blocked.state.blocked).toBe("no Cloudflare token");
    // BLOCKED in front of the domain question is the domain question (Codex on gpt-6.1-sol, run 16).
    const asked = user();
    const action = asked.onInput({
      kind: "turn_end",
      text: "Dependencies installed.\n\nBLOCKED: Waiting for your domain. Which domain should I use for `apps.<your domain>`?",
      hadResultEvent: true,
    });
    expect(action).toMatchObject({ type: "reply" });
    expect(asked.state.blocked).toBeNull();
    expect(asked.state.exercised).toContain("domain_question");
  });
  it("waits while a setup is in flight in the event log, whatever the harness did", () => {
    const u = user();
    u.onInput({ kind: "setup_started" });
    const action = u.onInput({
      kind: "turn_end",
      text: "I'll wait for setup.",
      hadResultEvent: true,
    });
    expect(action).toMatchObject({ type: "wait" });
    u.onInput({ kind: "setup_ended", status: "done" });
    expect(
      u.onInput({
        kind: "turn_end",
        text: "Setup is done.",
        hadResultEvent: true,
      }),
    ).toMatchObject({
      type: "reply",
      trigger: "create_app",
      text: CREATE_APP_REPLY,
      expected: true,
    });
  });
  it("hears a question dressed in markdown (launch gate run 2)", () => {
    expect(
      isDomainQuestion(
        "**Which domain should I use?** Your Gateway will be at `apps.<your domain>`.",
      ),
    ).toBe(true);
    expect(isDomainQuestion("- _Which domain should I use?_")).toBe(true);
    expect(isFourAppsQuestion("**Any you don't want?**")).toBe(true);
  });
  it("stops waiting after the setup cap", () => {
    let t = Date.UTC(2026, 9, 25, 14, 0, 0);
    const u = user({ now: () => new Date(t) });
    u.onInput({ kind: "setup_started" });
    t += (CAPS.setupWaitMinutes + 1) * 60_000;
    expect(
      u.onInput({
        kind: "turn_end",
        text: "still waiting",
        hadResultEvent: true,
      }),
    ).toMatchObject({ type: "reply", trigger: "turn_end_without_done" });
  });
  it("sends the universal reply as a nudge, three times, then stops", () => {
    const u = user();
    for (let i = 0; i < CAPS.nudges; i++) {
      expect(
        u.onInput({
          kind: "turn_end",
          text: "Let me know how to proceed.",
          hadResultEvent: true,
        }),
      ).toEqual({
        type: "reply",
        trigger: "turn_end_without_done",
        text: universalReply(zone),
        expected: false,
      });
    }
    expect(
      u.onInput({ kind: "turn_end", text: "?", hadResultEvent: true }),
    ).toEqual({ type: "stop", reason: "caps_exceeded" });
    expect(
      u.state.interventions.filter((i) => i.kind === "nudge"),
    ).toHaveLength(3);
  });
  it("resumes after an exit without a result event at most twice", () => {
    const u = user();
    expect(
      u.onInput({ kind: "turn_end", text: "", hadResultEvent: false }),
    ).toMatchObject({
      type: "reply",
      trigger: "harness_exit",
      expected: false,
    });
    expect(
      u.onInput({ kind: "turn_end", text: "", hadResultEvent: false }),
    ).toMatchObject({ type: "reply", trigger: "harness_exit" });
    expect(
      u.onInput({ kind: "turn_end", text: "", hadResultEvent: false }),
    ).toEqual({ type: "stop", reason: "caps_exceeded" });
    expect(u.state.interventions.map((i) => i.kind)).toEqual([
      "resume_after_exit",
      "resume_after_exit",
    ]);
  });
  it("records no_done when everything happened and DONE never came", () => {
    const u = user();
    u.onInput({ kind: "setup_started" });
    u.onInput({ kind: "setup_ended", status: "done" });
    u.onInput({ kind: "app_deployed" });
    const action = u.onInput({
      kind: "turn_end",
      text: "The app is live at https://hello.apps.everyapp-loop1.com",
      hadResultEvent: true,
    });
    expect(action).toMatchObject({
      type: "reply",
      trigger: "turn_end_without_done",
    });
    expect(u.state.interventions.map((i) => i.kind)).toEqual([
      "no_done",
      "nudge",
    ]);
  });
  it("relays a person's answer as an intervention", () => {
    const u = user();
    expect(u.onInput({ kind: "person", text: "try again" })).toEqual({
      type: "reply",
      trigger: "person",
      text: "try again",
      expected: false,
    });
    expect(u.state.interventions).toEqual([
      expect.objectContaining({
        source: "person",
        kind: "person_answer",
        text: "try again",
      }),
    ]);
  });
});

describe("detectors", () => {
  it("recognises domain questions and not mentions or narration about asking", () => {
    for (const question of [
      "Which domain would you like to use?",
      "Please provide the domain to use.",
      "Please tell me your domain.",
      "What domain should I use?",
      "I've read the docs. Could you tell me the domain you want to use?",
      "Tell me your domain and I'll run setup.",
    ])
      expect(isDomainQuestion(question), question).toBe(true);
    for (const narration of [
      "Running setup with --domain apps.example.com now.",
      "I will first ask you which domain to use, then run setup.",
      "Reading setup.md to learn what domain format setup expects",
      "Let me check what the domain flag expects",
      "Setup needs a domain under an active zone; I'll run it in the background.",
    ])
      expect(isDomainQuestion(narration), narration).toBe(false);
  });
  it("parses DONE with the Gateway URL on the same line, on the next line, or after the app URL", () => {
    const gateway = "https://apps.x.com";
    expect(parseDone("DONE https://apps.x.com")).toEqual({
      done: true,
      url: "https://apps.x.com",
    });
    expect(parseDone("DONE\nGateway URL: https://apps.x.com", gateway)).toEqual(
      {
        done: true,
        url: "https://apps.x.com",
      },
    );
    expect(
      parseDone(
        "DONE — app: https://hello.apps.x.com, gateway: https://apps.x.com/sign-in.",
        gateway,
      ),
    ).toEqual({ done: true, url: "https://apps.x.com/sign-in" });
    // No gateway URL in the text: the first URL after DONE is the fallback.
    expect(parseDone("DONE, see https://hello.apps.x.com", gateway)).toEqual({
      done: true,
      url: "https://hello.apps.x.com",
    });
    // A URL before DONE is not the answer.
    expect(
      parseDone("I opened https://dash.cloudflare.com earlier. DONE"),
    ).toEqual({ done: true, url: null });
    expect(parseDone("Everything is DONE.")).toEqual({ done: true, url: null });
    expect(parseDone("not yet")).toEqual({ done: false, url: null });
    expect(parseBlocked("BLOCKED: Workers Paid needed")).toBe(
      "Workers Paid needed",
    );
    expect(parseBlocked("fine")).toBeNull();
  });
  it("lists the seven expected hand-offs", () => {
    expect(EXPECTED_HANDOFFS).toEqual([
      "early_adopter_question",
      "domain_question",
      "claim_owner",
      "register_workers_subdomain",
      "create_app",
      "four_apps_question",
      "ACCESS_TEAM_REQUIRED",
    ]);
  });
});
