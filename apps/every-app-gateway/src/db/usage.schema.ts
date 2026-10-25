import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/**
 * What an organization's apps spent through the gateway: one row per
 * organization, app, user, kind, target and UTC day. Counted at the
 * AppGateway entrypoint after a provider answered, never on a refusal.
 * Only counts: never a prompt, a body or a key. No foreign keys, so the
 * trail outlives the user and the app, like `mcp_tool_calls`; the hourly
 * maintenance deletes rows past 13 months.
 */
export const usageDaily = sqliteTable(
  "usage_daily",
  {
    // The organization the call was attributed to.
    organizationId: text("organization_id").notNull(),
    // `apps.id`; for a shared app, the platform organization's row.
    appRowId: text("app_row_id").notNull(),
    // '' when the call was the app's own: background work, or a forwarded
    // identity that didn't verify.
    userId: text("user_id").notNull(),
    // "ai" | "capability"
    kind: text("kind").notNull(),
    // The AI provider (openai, openrouter, workers-ai) or the capability
    // (dataforseo, context, email, members, ...).
    target: text("target").notNull(),
    // UTC "YYYY-MM-DD".
    day: text("day").notNull(),
    calls: integer("calls").notNull().default(0),
    // Calls the provider answered with a status of 400 or more.
    failures: integer("failures").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    // Provider-reported cost in millionths of a US dollar (DataForSEO's
    // `cost`); 0 when the provider reports none.
    costMicros: integer("cost_micros").notNull().default(0),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.organizationId,
        table.appRowId,
        table.userId,
        table.kind,
        table.target,
        table.day,
      ],
    }),
    index("usage_daily_org_day_idx").on(table.organizationId, table.day),
    index("usage_daily_app_day_idx").on(table.appRowId, table.day),
  ],
);

/**
 * The same, summed per organization, app and UTC month: the one row a
 * per-app monthly cap reads. Deleted past 25 months.
 */
export const usageMonthly = sqliteTable(
  "usage_monthly",
  {
    organizationId: text("organization_id").notNull(),
    appRowId: text("app_row_id").notNull(),
    // UTC "YYYY-MM".
    month: text("month").notNull(),
    calls: integer("calls").notNull().default(0),
    failures: integer("failures").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costMicros: integer("cost_micros").notNull().default(0),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.appRowId, table.month],
    }),
  ],
);

/**
 * AI calls by model: one row per organization, app, provider, model and
 * UTC month, written beside `usage_daily` for a call the AI proxy read a
 * model off (the request body's `model`, or the default the Gateway
 * filled in). What Manage workspace → Usage shows under each provider.
 * Counts only, like the tables above; deleted past 25 months.
 */
export const usageModels = sqliteTable(
  "usage_models",
  {
    organizationId: text("organization_id").notNull(),
    appRowId: text("app_row_id").notNull(),
    // The AI provider the call went to (openrouter), never `default`.
    provider: text("provider").notNull(),
    // The model as the provider names it (anthropic/claude-haiku-5.5).
    model: text("model").notNull(),
    // UTC "YYYY-MM".
    month: text("month").notNull(),
    calls: integer("calls").notNull().default(0),
    failures: integer("failures").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costMicros: integer("cost_micros").notNull().default(0),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.organizationId,
        table.appRowId,
        table.provider,
        table.model,
        table.month,
      ],
    }),
    index("usage_models_org_month_idx").on(table.organizationId, table.month),
  ],
);
