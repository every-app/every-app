/** The provider totals every usage summary row carries. */
export interface UsageTotals {
  calls: number;
  /** Calls the provider answered with a status of 400 or more. */
  failures: number;
  inputTokens: number;
  outputTokens: number;
  /** Provider-reported cost in millionths of a US dollar. */
  costMicros: number;
}

export interface UsageAppRow extends UsageTotals {
  appRowId: string;
  /** Null once the app's row is gone. */
  name: string | null;
  appSlug: string | null;
  /** Allowed MCP tool calls on the app in the month (`mcp_tool_calls`). */
  toolCalls: number;
  /**
   * The organization's own cap on the app's provider calls per UTC month
   * (`org_app_settings`), or null; always null on an app that is not
   * callable.
   */
  monthlyCallCap: number | null;
  /** The app has no cap even though the organization set a default. */
  capUnlimited: boolean;
  /**
   * The cap that binds the app this month: its own, else the
   * organization's default unless the app is unlimited; null when nothing
   * binds. `capSource` says which.
   */
  effectiveMonthlyCallCap: number | null;
  capSource: "app" | "default" | null;
  /**
   * The app has reached its effective cap in the current UTC month, so the
   * Gateway refuses its AI and provider calls until the month ends or the
   * cap is raised. Always false for a past month.
   */
  paused: boolean;
  /**
   * The organization can call the app today (its own live app, or a shared
   * one), so a cap can be set on it. Every callable app is listed, with
   * zeros in a month it made no call; a deleted app shows only in a month
   * it spent in, and cannot be capped.
   */
  callable: boolean;
}

export interface UsageMemberRow extends UsageTotals {
  /** '' for the apps' own calls (background work). */
  userId: string;
  /** Null unless the person is a member of the organization today. */
  name: string | null;
  email: string | null;
  toolCalls: number;
}

export interface UsageTargetRow extends UsageTotals {
  /** "ai" | "capability" */
  kind: string;
  target: string;
}

/** What `setAppMonthlyCap` answers: the app's row and what binds it now. */
export interface AppCapState {
  appRowId: string;
  /** The app's own cap, or null. */
  monthlyCallCap: number | null;
  /** The app has no cap, whatever the organization's default. */
  capUnlimited: boolean;
  /** The cap that binds the app this month, and where it comes from. */
  effectiveMonthlyCallCap: number | null;
  capSource: "app" | "default" | null;
}

/**
 * What an organization's apps spent in a UTC month ("YYYY-MM"), three
 * ways, with the organization's default cap (null for none).
 */
export interface UsageSummary {
  month: string;
  defaultMonthlyCallCap: number | null;
  byApp: UsageAppRow[];
  byMember: UsageMemberRow[];
  byTarget: UsageTargetRow[];
}
