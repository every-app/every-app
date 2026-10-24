/**
 * The scripted user (design 4.5): a fixed reply table, caps, and the line
 * between an expected hand-off (the prompt itself creates it; answering is
 * not an intervention) and an intervention (a nudge, a repeated answer, a
 * resume, a person's text). Pure decisions: the driver executes the
 * actions and times the waits. Every reply is logged in scriptedUserTurns.
 */
import type {
  ExpectedHandoff,
  Intervention,
  ScriptedUserAction,
  ScriptedUserInput,
  ScriptedUserReply,
  ScriptedUserTrigger,
} from "./types";

export const EXPECTED_HANDOFFS: readonly ExpectedHandoff[] = [
  "domain_question",
  "claim_owner",
  "register_workers_subdomain",
  "create_app",
  "ACCESS_TEAM_REQUIRED",
];

/** Stops the run as fail-infra: the runbook, not the scripted user, fixes these. */
export const FIXTURE_ACTIONS: readonly string[] = [
  "cloudflare_login",
  "choose_account",
  "upgrade_workers_paid",
  "add_domain",
  "CLOUDFLARE_TOKEN_REJECTED",
];

export const CAPS = {
  /** Universal replies per run; expected hand-offs are unlimited. */
  nudges: 3,
  /** Resumes after a harness exit without a result event. */
  resumesAfterExit: 2,
  /** The whole run. */
  runMinutes: 90,
  /** How long a `setup` with a start and no end in the event log holds every reply. */
  setupWaitMinutes: 15,
  /** After the subdomain PUT, before "Done, continue". */
  subdomainSettleSeconds: 10,
} as const;

/** Never "use apps.<zone>": that invites apps.apps.<zone>. The argv must end up with --domain apps.<zone>. */
export const domainReply = (zone: string) => `My domain is ${zone}`;
const CONTINUE_REPLY = "Done, continue";
export const CREATE_APP_REPLY =
  "Now create an app called hello and deploy it: `pnpm everyapp create hello --json`, then from its folder `pnpm everyapp deploy --json`; tell me its URL.";
const teamReply = (team: string) => `Use --team ${team}`;
export const universalReply = (zone: string) =>
  `My domain is ${zone}. The Cloudflare token is in CLOUDFLARE_API_TOKEN. The owner account exists. Continue; if blocked say BLOCKED: <why>.`;

/** The workers.dev name the scripted user registers when setup stops on register_workers_subdomain. */
export const subdomainFor = (accountName: string) =>
  `everyapp-${accountName.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;

/** A sentence that asks: ends in a question mark, or opens as a request. */
const QUESTION_FORM =
  /\?\s*$|^(please|tell me|provide|what is|what's|which|could you|can you|would you|let me know|i need (you to|your))\b/i;
/** Narration about asking, never a question to the person ("I will first ask you which domain to use"). */
const NARRATION =
  /\bask(ing)? (you|me|the user)\b|\b(will|going to|need to|should) ask\b/i;
const DOMAIN_WORD = /\b(domain|zone)\b/i;

/**
 * Does this text ask the person for the domain? Judged sentence by sentence
 * on the text a turn ended with, never on mid-turn narration: an agent that
 * echoes the prompt's plan ("I will first ask you which domain to use")
 * or reads a doc ("learn what domain format setup expects") is not asking.
 */
export function isDomainQuestion(text: string): boolean {
  return text
    .split(/(?<=[.?!])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .some(
      (sentence) =>
        DOMAIN_WORD.test(sentence) &&
        !NARRATION.test(sentence) &&
        QUESTION_FORM.test(sentence),
    );
}

const URL_PATTERN = /https?:\/\/[^\s)`'"<>]+/g;

/**
 * `DONE` and the Gateway URL, from the text a turn ended with. Every URL
 * after DONE counts (the prompt says "print DONE and the Gateway URL", so
 * "DONE\nGateway URL: https://…" and "DONE — app: https://hello…, gateway:
 * https://…" are both likely); the one whose origin is the gateway's wins,
 * the first is the fallback.
 */
export function parseDone(
  text: string,
  gatewayOrigin?: string,
): { done: boolean; url: string | null } {
  const at = /\bDONE\b/.exec(text);
  if (!at) return { done: false, url: null };
  const urls = [...text.slice(at.index).matchAll(URL_PATTERN)].map((m) =>
    m[0]!.replace(/[.,;:]+$/, ""),
  );
  const origin = gatewayOrigin ? originOf(gatewayOrigin) : null;
  const gateway = origin
    ? urls.find((url) => originOf(url) === origin)
    : undefined;
  return { done: true, url: gateway ?? urls[0] ?? null };
}

/** `https://apps.example.com/sign-in` → `https://apps.example.com`; null when not a URL. */
export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function parseBlocked(text: string): string | null {
  const match = /\bBLOCKED:\s*(.{0,200})/.exec(text);
  return match ? match[1]!.trim() : null;
}

interface ScriptedUserOptions {
  zone: string;
  accountName: string;
  withAccess: boolean;
  /** `--claim-after`: immediate replies to nothing on claim_owner (the claimer handles it); turn-end waits for the turn to end first. */
  claimAfter?: "immediate" | "turn-end";
  now?: () => Date;
}

export interface ScriptedUserState {
  turns: ScriptedUserReply[];
  interventions: Intervention[];
  nudges: number;
  resumes: number;
  /** A setup started in the event log and has not ended. */
  setupInFlight: boolean;
  setupInFlightSince: string | null;
  setupDone: boolean;
  appDeployed: boolean;
  /** Expected hand-offs answered so far (a second answer to the same one is a repeated_answer intervention). */
  exercised: ExpectedHandoff[];
  /** A fixture action was seen: the run is over as fail-infra. */
  fixtureError: string | null;
  blocked: string | null;
  done: { url: string | null } | null;
}

export interface ScriptedUser {
  state: ScriptedUserState;
  /** One input in, zero or one action out. */
  onInput(input: ScriptedUserInput): ScriptedUserAction | null;
}

export function createScriptedUser(options: ScriptedUserOptions): ScriptedUser {
  const now = options.now ?? (() => new Date());
  const state: ScriptedUserState = {
    turns: [],
    interventions: [],
    nudges: 0,
    resumes: 0,
    setupInFlight: false,
    setupInFlightSince: null,
    setupDone: false,
    appDeployed: false,
    exercised: [],
    fixtureError: null,
    blocked: null,
    done: null,
  };

  const log = (
    trigger: ScriptedUserTrigger,
    reply: string,
    expected: boolean,
  ): ScriptedUserReply => {
    const turn = { at: now().toISOString(), trigger, reply, expected };
    state.turns.push(turn);
    return turn;
  };

  const intervene = (
    kind: Intervention["kind"],
    source: Intervention["source"],
    text?: string,
  ) => {
    state.interventions.push({
      at: now().toISOString(),
      source,
      kind,
      ...(text ? { text } : {}),
    });
  };

  /** An expected hand-off's reply; the second time it is also a repeated_answer intervention. */
  const expectedReply = (
    handoff: ExpectedHandoff,
    text: string,
  ): ScriptedUserAction => {
    const repeated = state.exercised.includes(handoff);
    if (!repeated) state.exercised.push(handoff);
    else intervene("repeated_answer", "loop", `${handoff} answered again`);
    log(handoff, text, !repeated);
    return { type: "reply", trigger: handoff, text, expected: !repeated };
  };

  const nudge = (
    trigger: "turn_end_without_done" | "harness_exit",
  ): ScriptedUserAction => {
    if (trigger === "harness_exit") {
      if (state.resumes >= CAPS.resumesAfterExit)
        return { type: "stop", reason: "caps_exceeded" };
      state.resumes += 1;
      intervene("resume_after_exit", "loop");
    } else {
      if (state.nudges >= CAPS.nudges)
        return { type: "stop", reason: "caps_exceeded" };
      state.nudges += 1;
      intervene("nudge", "loop");
    }
    const text = universalReply(options.zone);
    log(trigger, text, false);
    return { type: "reply", trigger, text, expected: false };
  };

  const waitForSetup = (): ScriptedUserAction | null => {
    if (!state.setupInFlight) return null;
    const since = Date.parse(state.setupInFlightSince ?? now().toISOString());
    const untilMs = since + CAPS.setupWaitMinutes * 60_000;
    if (now().getTime() >= untilMs) return null;
    return {
      type: "wait",
      reason: "setup is still running in the harness",
      untilMs,
    };
  };

  return {
    state,
    onInput(input): ScriptedUserAction | null {
      if (state.fixtureError)
        return { type: "fixture_error", code: state.fixtureError };
      switch (input.kind) {
        case "setup_started":
          state.setupInFlight = true;
          state.setupInFlightSince = now().toISOString();
          return null;
        case "setup_ended":
          // "killed": the process is gone with no exit line (the harness killed its background
          // task); the reply held for it goes out at once.
          state.setupInFlight = false;
          if (input.status === "done") state.setupDone = true;
          return null;
        case "app_deployed":
          state.appDeployed = true;
          return null;
        case "cli_error":
          if (FIXTURE_ACTIONS.includes(input.code)) {
            state.fixtureError = input.code;
            return { type: "fixture_error", code: input.code };
          }
          if (
            input.code === "DOMAIN_REQUIRED" &&
            state.exercised.includes("domain_question")
          ) {
            // The domain was given and setup still asked: a fixture error, never answered twice.
            state.fixtureError = "DOMAIN_REQUIRED_AFTER_ANSWER";
            return { type: "fixture_error", code: state.fixtureError };
          }
          if (input.code === "ACCESS_TEAM_REQUIRED" && options.withAccess) {
            return expectedReply(
              "ACCESS_TEAM_REQUIRED",
              teamReply(subdomainFor(options.accountName)),
            );
          }
          return null;
        case "action_required": {
          if (FIXTURE_ACTIONS.includes(input.action)) {
            state.fixtureError = input.action;
            return { type: "fixture_error", code: input.action };
          }
          if (input.action === "register_workers_subdomain") {
            const subdomain = subdomainFor(options.accountName);
            const repeated = state.exercised.includes(
              "register_workers_subdomain",
            );
            if (!repeated) state.exercised.push("register_workers_subdomain");
            else
              intervene(
                "repeated_answer",
                "loop",
                "register_workers_subdomain again",
              );
            log(
              "register_workers_subdomain",
              `PUT /workers/subdomain {subdomain: ${subdomain}}; then "${CONTINUE_REPLY}"`,
              !repeated,
            );
            return {
              type: "register_workers_subdomain",
              subdomain,
              thenReply: CONTINUE_REPLY,
            };
          }
          if (input.action === "claim_owner") {
            // The claimer (claim.ts) answers this over HTTP; the hand-off is exercised, no text goes to the harness.
            if (!state.exercised.includes("claim_owner"))
              state.exercised.push("claim_owner");
            return null;
          }
          return null;
        }
        case "assistant_text":
          // Mid-turn text is narration until the turn ends on it: the domain question is answered
          // at turn_end, from the text the harness stopped on.
          return null;
        case "turn_end": {
          const blocked = parseBlocked(input.text);
          // "BLOCKED: Waiting for your domain. Which domain should I use?" (Codex on gpt-6.1-sol,
          // run 16) is the domain question wearing the prompt's BLOCKED prefix; a person would
          // answer it. Only a BLOCKED with no recognised question stops the run.
          if (blocked && !(isDomainQuestion(input.text) && !state.setupDone)) {
            state.blocked = blocked;
            return { type: "stop", reason: "blocked" };
          }
          const done = parseDone(input.text, `https://apps.${options.zone}`);
          if (done.done) {
            state.done = { url: done.url };
            return { type: "stop", reason: "done" };
          }
          const waiting = waitForSetup();
          if (waiting) return waiting;
          if (!input.hadResultEvent) return nudge("harness_exit");
          if (isDomainQuestion(input.text) && !state.setupDone) {
            return expectedReply("domain_question", domainReply(options.zone));
          }
          if (
            state.setupDone &&
            !state.appDeployed &&
            !state.exercised.includes("create_app")
          ) {
            return expectedReply("create_app", CREATE_APP_REPLY);
          }
          if (state.setupDone && state.appDeployed) {
            // Everything happened, DONE was never printed: one nudge asks for it, recorded as no_done.
            intervene("no_done", "loop");
          }
          return nudge("turn_end_without_done");
        }
        case "person":
          intervene("person_answer", "person", input.text);
          log("person", input.text, false);
          return {
            type: "reply",
            trigger: "person",
            text: input.text,
            expected: false,
          };
      }
    },
  };
}
