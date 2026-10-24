/**
 * Email Routing in a zone, through cf (`cf email-routing …`, all of it
 * zone-scoped with `-z <zone id>`): its settings, enabling it on a domain,
 * its routing rules and its catch-all. Request bodies go to cf in a file
 * (`--body @<file>`). cf prints the API's `result` unwrapped; the schemas
 * keep only what callers read. These calls run live: agentic-inbox's
 * inbound addresses on everyapp.team are routed through them.
 */
import { z } from "zod";
import { CfError, isCfError } from "./errors";
import { runCfJson, type CfRunner } from "./runner";

/** `cf email-routing settings get`: whether the zone routes mail. */
const EmailRoutingSettingsOutput = z.looseObject({
  enabled: z.boolean(),
  name: z.string().nullish(),
  /** "ready", "unconfigured", "misconfigured", "misconfigured/locked" or "unlocked". */
  status: z.string().nullish(),
});
export type EmailRoutingSettings = z.infer<typeof EmailRoutingSettingsOutput>;

const RuleMatcher = z.looseObject({
  type: z.string(),
  field: z.string().nullish(),
  value: z.string().nullish(),
});

const RuleAction = z.looseObject({
  type: z.string(),
  value: z.array(z.string()).nullish(),
});

/** A routing rule, or the zone's catch-all: `id` (or the older `tag`). */
const EmailRoutingRuleOutput = z
  .looseObject({
    id: z.string().nullish(),
    tag: z.string().nullish(),
    name: z.string().nullish(),
    enabled: z.boolean().nullish(),
    matchers: z.array(RuleMatcher).nullish(),
    actions: z.array(RuleAction).nullish(),
  })
  .transform((rule) => ({
    id: rule.id ?? rule.tag ?? null,
    name: rule.name ?? null,
    enabled: rule.enabled ?? true,
    matchers: rule.matchers ?? [],
    actions: rule.actions ?? [],
  }));
export type EmailRoutingRule = z.infer<typeof EmailRoutingRuleOutput>;

const EmailRoutingRuleListOutput = z.array(EmailRoutingRuleOutput);

/** What a rule or catch-all is set to. */
export interface EmailRoutingRuleBody {
  name: string;
  enabled: boolean;
  matchers: Array<{ type: "literal"; field: "to"; value: string } | { type: "all" }>;
  actions: Array<{ type: "worker" | "drop"; value?: string[] }>;
}

const PAGE_SIZE = 50;
const MAX_PAGES = 10;

export function getEmailRoutingSettings(
  cf: CfRunner,
  zoneId: string,
): Promise<EmailRoutingSettings> {
  return runCfJson(
    cf,
    {
      plane: "account",
      args: ["email-routing", "settings", "get", "-z", zoneId],
    },
    EmailRoutingSettingsOutput,
  );
}

/**
 * Turn Email Routing on for `domain` (the zone's apex, or a subdomain of
 * it): Cloudflare adds and locks its MX and SPF records, so the domain's
 * mail goes to Cloudflare from then on.
 */
export async function enableEmailRouting(
  cf: CfRunner,
  zoneId: string,
  domain: string,
): Promise<void> {
  await cf.run({
    plane: "account",
    mode: "json",
    args: ["email-routing", "enable", "-z", zoneId, "--name", domain],
  });
}

/**
 * Turn the zone's Email Routing off (`cf email-routing disable`, `--force`
 * answering cf's confirmation): Cloudflare removes the MX records it added
 * for it. Only for a zone whose rules are all gone (the teardown).
 */
export async function disableEmailRouting(cf: CfRunner, zoneId: string): Promise<void> {
  await cf.run({
    plane: "account",
    mode: "json",
    args: ["email-routing", "disable", "-z", zoneId, "--force"],
  });
}

/**
 * Every routing rule in the zone (its catch-all is apart). A page that
 * brings nothing new ends the listing too, so an API that ignores the
 * page asked for can't loop.
 */
export async function listEmailRoutingRules(
  cf: CfRunner,
  zoneId: string,
): Promise<EmailRoutingRule[]> {
  const rules = new Map<string, EmailRoutingRule>();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await runCfJson(
      cf,
      {
        plane: "account",
        args: [
          "email-routing",
          "rules",
          "list-account",
          "-z",
          zoneId,
          "--per-page",
          String(PAGE_SIZE),
          "--page",
          String(page),
        ],
      },
      EmailRoutingRuleListOutput,
    );
    const before = rules.size;
    for (const [index, rule] of batch.entries()) {
      rules.set(rule.id ?? `${page}:${index}`, rule);
    }
    if (batch.length < PAGE_SIZE || rules.size === before) break;
  }
  return [...rules.values()];
}

/** One rule, or null once it's gone. */
export async function getEmailRoutingRule(
  cf: CfRunner,
  zoneId: string,
  ruleId: string,
): Promise<EmailRoutingRule | null> {
  try {
    return await runCfJson(
      cf,
      {
        plane: "account",
        args: ["email-routing", "rules", "get", ruleId, "-z", zoneId],
      },
      EmailRoutingRuleOutput,
    );
  } catch (error) {
    if (isCfError(error, "not_found")) return null;
    throw error;
  }
}

/** Create a rule; returns its id. */
export async function createEmailRoutingRule(
  cf: CfRunner,
  zoneId: string,
  rule: EmailRoutingRuleBody,
): Promise<string> {
  const created = await runCfJson(
    cf,
    {
      plane: "account",
      files: { "rule.json": rule },
      args: (files) => [
        "email-routing",
        "rules",
        "create",
        "-z",
        zoneId,
        "--body",
        `@${files["rule.json"]!}`,
      ],
    },
    EmailRoutingRuleOutput,
  );
  if (!created.id) {
    throw new CfError(
      {
        message: `cf email-routing rules create answered without the new rule's id.`,
        apiCodes: [],
        kind: "unknown",
      },
      { exitCode: 0, stderr: "" },
    );
  }
  return created.id;
}

/** Replace a rule's name, state, matchers and actions (a PUT). */
export async function updateEmailRoutingRule(
  cf: CfRunner,
  zoneId: string,
  ruleId: string,
  rule: EmailRoutingRuleBody,
): Promise<void> {
  await cf.run({
    plane: "account",
    mode: "json",
    files: { "rule.json": rule },
    args: (files) => [
      "email-routing",
      "rules",
      "update",
      ruleId,
      "-z",
      zoneId,
      "--body",
      `@${files["rule.json"]!}`,
    ],
  });
}

/** Delete a rule; false when it was gone already. */
export async function deleteEmailRoutingRule(
  cf: CfRunner,
  zoneId: string,
  ruleId: string,
): Promise<boolean> {
  try {
    await cf.run({
      plane: "account",
      mode: "json",
      args: ["email-routing", "rules", "delete", ruleId, "-z", zoneId, "--force"],
    });
    return true;
  } catch (error) {
    if (isCfError(error, "not_found")) return false;
    throw error;
  }
}

/** The zone's catch-all: what mail no rule matches gets. */
export function getEmailRoutingCatchAll(
  cf: CfRunner,
  zoneId: string,
): Promise<EmailRoutingRule> {
  return runCfJson(
    cf,
    {
      plane: "account",
      args: ["email-routing", "rules", "catch-all", "get", "-z", zoneId],
    },
    EmailRoutingRuleOutput,
  );
}

export async function updateEmailRoutingCatchAll(
  cf: CfRunner,
  zoneId: string,
  rule: EmailRoutingRuleBody,
): Promise<void> {
  await cf.run({
    plane: "account",
    mode: "json",
    files: { "catch-all.json": rule },
    args: (files) => [
      "email-routing",
      "rules",
      "catch-all",
      "update",
      "-z",
      zoneId,
      "--body",
      `@${files["catch-all.json"]!}`,
    ],
  });
}

/** The Worker a rule sends mail to, when it sends mail to one. */
export function ruleWorker(rule: Pick<EmailRoutingRule, "actions">): string | null {
  const action = rule.actions.find((candidate) => candidate.type === "worker");
  return action?.value?.[0] ?? null;
}

/** The address a rule's literal `to` matcher takes, in lowercase. */
export function ruleAddress(rule: Pick<EmailRoutingRule, "matchers">): string | null {
  const matcher = rule.matchers.find(
    (candidate) =>
      candidate.type === "literal" && (candidate.field ?? "to") === "to",
  );
  return matcher?.value ? matcher.value.toLowerCase() : null;
}
