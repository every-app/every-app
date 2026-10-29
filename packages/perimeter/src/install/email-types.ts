import { z } from "zod";
/** `cf email-routing settings get`: whether the zone routes mail. */
export const EmailRoutingSettingsOutput = z.looseObject({
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
export const EmailRoutingRuleOutput = z
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

export const EmailRoutingRuleListOutput = z.array(EmailRoutingRuleOutput);

/** What a rule or catch-all is set to. */
export interface EmailRoutingRuleBody {
  name: string;
  enabled: boolean;
  matchers: Array<
    { type: "literal"; field: "to"; value: string } | { type: "all" }
  >;
  actions: Array<{ type: "worker" | "drop"; value?: string[] }>;
}

/** The Worker a rule sends mail to, when it sends mail to one. */
export function ruleWorker(
  rule: Pick<EmailRoutingRule, "actions">,
): string | null {
  const action = rule.actions.find((candidate) => candidate.type === "worker");
  return action?.value?.[0] ?? null;
}

/** The address a rule's literal `to` matcher takes, in lowercase. */
export function ruleAddress(
  rule: Pick<EmailRoutingRule, "matchers">,
): string | null {
  const matcher = rule.matchers.find(
    (candidate) =>
      candidate.type === "literal" && (candidate.field ?? "to") === "to",
  );
  return matcher?.value ? matcher.value.toLowerCase() : null;
}
