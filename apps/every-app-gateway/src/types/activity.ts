/** Where a page of tool calls continues: its last row's time and id. */
export type ToolCallCursor = {
  /** `created_at` in milliseconds since the epoch. */
  createdAt: number;
  id: string;
};

/** An app the organization's audit trail names. */
export type ToolCallApp = {
  rowId: string;
  /** The slug at the time of the call; kept once the app is gone. */
  slug: string | null;
  /** The app's current name; null when its row is gone. */
  name: string | null;
  /**
   * True once the app was deleted: its row stays as a tombstone (the name
   * with it) until the slug is deployed again, or it is gone altogether.
   */
  removed: boolean;
};

/**
 * One MCP tool call as Admin → Activity lists it: who called which tool on
 * which app, the decision and what came of it. Never the arguments or the
 * result: the audit table holds neither.
 */
export type ToolCallRow = {
  id: string;
  /** Milliseconds since the epoch. */
  createdAt: number;
  user: {
    id: string;
    /** Null with `email` for a former member of the organization: they show by id. */
    name: string | null;
    email: string | null;
  };
  credential: {
    /** "oauth" | "pat" | "session" | "access" | "dev" */
    kind: string;
    /** The connected AI app's own name, when the credential has one. */
    clientName: string | null;
    /**
     * What the client called itself in the MCP handshake, `<name> <version>`
     * (at most 200 characters), so a token or Access caller still shows
     * which AI app called. Self-asserted, never verified; null when the
     * client sent none.
     */
    clientInfo: string | null;
  };
  app: Omit<ToolCallApp, "rowId"> & {
    /** Null for a call on no app, or on an app with no row (a dev registry). */
    rowId: string | null;
  };
  tool: {
    name: string;
    /** "read" | "write" | "destructive", or null when the tool was unknown. */
    risk: string | null;
    /**
     * The wrapper built-in the call came through (`everyapp_call_read` or
     * `everyapp_call_write`) when it did; `name` is then the inner tool's.
     * Null for a call made by name.
     */
    via: string | null;
  };
  decision: "allowed" | "blocked";
  /** Why it was blocked, or what the app reported. */
  reason: string | null;
  outcome: string;
  durationMs: number | null;
  resultBytes: number | null;
};

export type ToolCallsPage = {
  calls: ToolCallRow[];
  /** Pass as `before` for the next page; null on the last one. */
  nextBefore: ToolCallCursor | null;
};
