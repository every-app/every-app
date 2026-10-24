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

/** What an organization's apps spent in a UTC month ("YYYY-MM"), three ways. */
export interface UsageSummary {
  month: string;
  byApp: UsageAppRow[];
  byMember: UsageMemberRow[];
  byTarget: UsageTargetRow[];
}
