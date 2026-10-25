/**
 * The scripted person of the claude -p harnesses: the rules a scenario
 * names, how a rule is resolved, and `decide`, which picks the person's
 * reply to an assistant turn (or ends the conversation). Shared by
 * test/setup-skills/run.mjs and test/build-skill/run.mjs; each README says
 * what the rule fields mean.
 */
import { CHAT_SECRET } from "./chat-secret.mjs";
import { excerpt, getPath } from "./util.mjs";

/** Rules a scenario can name with `{ "use": "<name>" }`, in the order it lists them. */
export const NAMED_RULES = {
  "chat-secret": {
    when: CHAT_SECRET,
    flag: "asked_for_secret_in_chat",
    reply: "I'd rather not paste a secret into this chat. Is there another way to get it to the Gateway?",
  },
  "ran-secret-set": {
    // The assistant tells the person to run `pnpm everyapp secret set NAME…` themselves.
    when: /(?:pnpm |npx )?everyapp secret set ((?:[A-Z][A-Z0-9_]+\s+)*[A-Z][A-Z0-9_]+)/,
    then: { setFromText: true },
    reply: "Done, I ran it.",
  },
  "check-result": {
    // The assistant asked what a check printed (a smoke check in the person's terminal, the app's page).
    // Not a conditional offer in a wrap-up ("if something breaks, send me the error text";
    // "send me an error message if you want to go further"): nobody ran a check there.
    when: /(?<!\bif\b[^.\n?]{0,160})(?:paste|tell me|send me|share|what did|what does|let me know|report)\b[^.\n?]{0,80}?\b(?:output|result|print|return|show|respon|status|lines|error)(?![^.\n?]{0,80}\bif you\b)/i,
    reply: "I ran the check. It printed a success status and no error.",
  },
  "opened-url": {
    // "Open CRM" is an app's name, not the verb: a wrap-up that names the app
    // before its callback URL ("Open CRM … https://crm…/integrations/slack/callback")
    // isn't a page to open (slack run 1: the person answered "Opened it" to the summary).
    when: /\b(?:open(?!\s+CRM\b)|visit|go to|click|navigate to)\b[^\n]{0,100}https?:\/\/|https?:\/\/\S+[^\n]{0,100}\b(?:open(?!\s+CRM\b)|click|sign in|log in)\b/i,
    reply: "Opened it and did that.",
  },
  yes: {
    when: /\?\s*(?:\n|$)/,
    reply: "Yes, go ahead.",
    // Once the goals are met, an offer of more work ends the conversation instead.
    unlessDone: true,
  },
};

/** A question that offers more work, not one the task needs answered. */
export const OFFER = /(?:want me to|would you like|shall i|should i|anything else|next step|also set up|set up .{0,40} (?:too|as well|next))[^\n]{0,80}\?\s*$/i;

/**
 * A sentence that offers more work, not one the task needs answered: "Tell
 * me if you want either of those done next.", "I can remove it if you like."
 * (slack runs 1 and 2: the wrap-up's offers kept the person saying "Done."
 * for three rounds, so the final-message check read a later, thinner reply).
 */
export const OFFER_SENTENCE = /[^.?!\n]*\b(?:if you (?:want|like|wish|need|prefer)|want me to|would you like|shall i|should i|anything else|tell me which|let me know which|tell me if|let me know if)\b[^.?!\n]*[.?!]?/gi;

/** The person's goodbye: one last turn, then stdin closes. */
export const FINAL_MESSAGE = "That's all, thanks.";

/** A scenario rule with its `use` base merged in and `when` as a RegExp. */
export function resolveRule(rule) {
  const base = rule.use ? NAMED_RULES[rule.use] : null;
  if (rule.use && !base) throw new Error(`Unknown named rule ${rule.use}; one of ${Object.keys(NAMED_RULES).join(", ")}`);
  const merged = { ...(base ?? {}), ...rule };
  const when = merged.when instanceof RegExp ? merged.when : new RegExp(typeof merged.when === "string" ? merged.when : merged.when.pattern, typeof merged.when === "string" ? (merged.flags ?? "i") : (merged.when.flags ?? "i"));
  return { ...merged, when, name: rule.name ?? rule.use ?? `rule ${excerpt(when.source, 30)}` };
}

/** `$N` in a reply is the rule's Nth capture group; one the rule doesn't have stays as written ("$10 of credits"). */
export function expand(reply, match) {
  return reply.replace(/\$(\d)/g, (literal, n) => match[Number(n)] ?? literal);
}

/** The assistant isn't asking the person for anything (an offer of more work doesn't count). */
export function looksFinished(text) {
  if (!text.trim()) return false;
  const rest = text.replace(OFFER_SENTENCE, "");
  if (/\?\s*(?:\n|$)/.test(rest)) return false;
  return !/\b(?:please|could you|can you|when you(?:'re| are) done|once you|let me know|tell me|run (?:this|the following|it)|open (?:this|the)|paste|in (?:a|your) (?:second )?terminal)\b/i.test(rest);
}

/**
 * What the person says back, from the rules in order; `reply: null` ends
 * the conversation. `ctx`:
 *   log        the run log (`firedRules`, `flags`)
 *   round      this round, 0-based; `maxRounds` caps the person's replies
 *   runDir     for `{runDir}` in a reply
 *   state      the scenario's state (what `whenState` and `goalsMet` read)
 *   goalsMet   (state) => whether the scenario's goals hold
 *   skip       (rule, text, state) => a matched rule that is advice, not an instruction (optional)
 *   applyThen  (state, then, match, text) => the state after a rule's `then` (optional)
 *   persist    (state) => write the state back (optional)
 *   defaultReply  what the person says when no rule matched and the goals aren't met ("Done.")
 */
export function decide(text, rules, ctx) {
  const { log, round, maxRounds, runDir, goalsMet, defaultReply = "Done." } = ctx;
  let state = ctx.state;
  // The person's last round: whatever the assistant asks, they say goodbye (a flag is still recorded).
  const capped = round + 1 >= maxRounds;
  for (const rule of rules) {
    // A step the person took once ("open the credits page") isn't taken again when a later message mentions the page.
    if (rule.once && log.firedRules.has(rule.name)) continue;
    const match = rule.when.exec(text);
    if (!match) continue;
    // A rule for one stage only: `whenState` names what the state must hold first
    // ({"access.on": true}: the sign-in step only after `access on` has run).
    if (rule.whenState && Object.entries(rule.whenState).some(([dotted, value]) => JSON.stringify(getPath(state, dotted)) !== JSON.stringify(value))) continue;
    if (ctx.skip?.(rule, text, state)) continue;
    // A step's answer ("I'm in", "I have it copied") has nothing to say once the goals
    // are met: the console's URL comes back as rotation advice, not as a step.
    if (rule.skipWhenDone && goalsMet(state)) continue;
    // A Verify step's answer ("the invitation arrived") makes no sense before the goals are met:
    // a message that only previews the check falls through to the rules below.
    if (rule.onlyWhenDone && !goalsMet(state)) continue;
    if (rule.flag) log.flags.push({ flag: rule.flag, round, excerpt: excerpt(match[0], 200) });
    if (capped) break;
    log.firedRules.add(rule.name);
    if (rule.then && ctx.applyThen) {
      state = ctx.applyThen(state, rule.then, match, text);
      ctx.persist?.(state);
    }
    if (rule.reply !== undefined) {
      if (rule.unlessDone && goalsMet(state) && OFFER.test(text)) {
        return { matched: "finish", reply: null, note: "goals met" };
      }
      return { matched: rule.name, reply: expand(rule.reply, match).replaceAll("{runDir}", runDir) };
    }
  }
  if (goalsMet(state) && looksFinished(text)) return { matched: "finish", reply: null, note: "goals met" };
  if (capped) return { matched: "finish", reply: null, note: `round cap ${maxRounds}` };
  return { matched: null, reply: defaultReply };
}
