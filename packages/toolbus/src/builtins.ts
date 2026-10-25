/**
 * Tools the gateway answers itself on its multi-app surface. Three are
 * answered from the view without calling any app: which apps the caller
 * reaches, who they act as, and a search over the tools they may call. Two
 * wrappers delegate exactly one app call each (`everyapp_call_read`,
 * `everyapp_call_write`), so a client that loads every tool definition can
 * work from a compact list: `everyapp_search_tools` finds a tool and its
 * input schema, a wrapper runs it. They are named under `everyapp`, an app
 * id no manifest may take, are listed before every app's tools, and are
 * marked to stay loaded in Claude Code.
 *
 * The third kind, `host`, is the workspace tools (workspace.ts): every
 * admin action of the gateway's UI, and a member's own tokens and
 * connections, run by the host through `ToolBusDeps.workspace`; and the
 * provider tools (providers.ts): the API provider registry, read by any
 * member and written by owners and admins where the host registers
 * providers (`WorkspaceHost.providers`). They are listed in the full
 * listing only, to a caller whose role reaches each tool's `minRole` and
 * whose credential reaches every app (never to a token bound to one app
 * or a connection consented to some), and found by the search and run by
 * the wrappers in either mode; without a host to run them they are not
 * listed at all.
 */
import type { Tool } from "@modelcontextprotocol/server";
import type { ToolCallResultV1 } from "@every-app/sdk/internal";
import { namespacedToolName } from "./names";
import { evaluateToolPolicy } from "./policy";
import type {
  JsonObject,
  McpAccess,
  ToolBusApp,
  ToolBusTool,
  ToolBusView,
  WorkspaceRole,
} from "./types";
import { PROVIDER_TOOLS } from "./providers";
import { WORKSPACE_TOOLS } from "./workspace";

/** The reserved app id the built-in tools are namespaced under. */
export const BUILTIN_APP_ID = "everyapp";

/** How the gateway surface lists tools (`ToolBusView.listing`). */
export type ListingMode = NonNullable<ToolBusView["listing"]>;

/**
 * What the host supplies, as the listing and the search need to know it:
 * whether the workspace tools have handlers (`ToolBusDeps.workspace`), and
 * whether the host registers providers here (`WorkspaceHost.providers`),
 * which the provider tools that write rows need.
 */
export interface BuiltinHostOptions {
  workspace?: boolean;
  providers?: boolean;
}

/** Whether the host runs this `host`-kind tool: its handlers, and what the tool needs beyond them. */
function hostRuns(
  tool: { needs?: "providers" },
  host: BuiltinHostOptions,
): boolean {
  return (
    host.workspace === true &&
    (tool.needs !== "providers" || host.providers === true)
  );
}

/**
 * A search answer stops taking tools once it would serialize past this
 * (the result as the audit counts it: the JSON text and its structured
 * copy): 25 tools with 20 KiB schemas would otherwise be a megabyte.
 */
export const SEARCH_RESULT_MAX_BYTES = 256 * 1024;
const SEARCH_QUERY_MAX_CHARS = 200;
const SEARCH_APP_MAX_CHARS = 64;
const SEARCH_LIMIT_DEFAULT = 10;
const SEARCH_LIMIT_MAX = 25;
/** The longest tool name a wrapper takes: the spec's limit. */
const WRAPPED_NAME_MAX_CHARS = 128;

/**
 * Claude Code defers every MCP tool behind its tool search unless the
 * server sets this key in the tool's `_meta` (read since 2.1.285). The
 * built-ins are how a model finds its way in (which apps exist, who it acts
 * as, how to find and run a tool), so they stay loaded while app tools stay
 * deferred. A person's server-level `alwaysLoad: false` still wins (2.1.287
 * and later); other clients ignore the key.
 */
const ALWAYS_LOAD_META_KEY = "anthropic/alwaysLoad";

/** What a view-answered built-in says: its data, or what's wrong with the arguments. */
type BuiltinAnswer = { data: JsonObject } | { problem: string };

export type BuiltinTool = ToolBusTool & {
  /** The listing modes the built-in appears in; it is callable in both. */
  listedIn: readonly ListingMode[];
} & (
    | {
        kind: "answer";
        run(
          view: ToolBusView,
          args: JsonObject,
          host: BuiltinHostOptions,
        ): BuiltinAnswer;
      }
    | {
        /** Delegates one app call; `ceiling` is the highest risk it reaches. */
        kind: "wrapper";
        ceiling: McpAccess;
      }
    | {
        /** Run by the host (`ToolBusDeps.workspace`); hidden below `minRole`. */
        kind: "host";
        minRole: WorkspaceRole;
        irreversible?: true;
        /** Hidden unless the host offers this too (`BuiltinHostOptions.providers`). */
        needs?: "providers";
      }
  );

/** A built-in's kind: the two view-answered kinds and the wrappers, or `host`. */
export type BuiltinKind = BuiltinTool["kind"];

const NO_INPUT = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const CALL_INPUT = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description:
        "The tool's name as everyapp_search_tools lists it: `<app>_<tool>`.",
      minLength: 1,
      maxLength: WRAPPED_NAME_MAX_CHARS,
    },
    arguments: {
      type: "object",
      description: "The tool's arguments, as its input schema describes them.",
    },
  },
  required: ["name"],
  additionalProperties: false,
};

const SEARCH_INPUT = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "Words to look for in tool names, titles and descriptions. Give a query, an app id, or both.",
      minLength: 1,
      maxLength: SEARCH_QUERY_MAX_CHARS,
    },
    app: {
      type: "string",
      description: "An app id (from everyapp_list_apps): only its tools.",
      minLength: 1,
      maxLength: SEARCH_APP_MAX_CHARS,
    },
    limit: {
      type: "integer",
      description: "How many tools to return at most.",
      minimum: 1,
      maximum: SEARCH_LIMIT_MAX,
      default: SEARCH_LIMIT_DEFAULT,
    },
  },
  additionalProperties: false,
};

/** One tool the search runs over: an app's, or a workspace tool of the gateway's. */
interface SearchableTool {
  appId: string;
  tool: ToolBusTool;
}

/**
 * The tools this caller may call, as the policy leaves them: every app's,
 * and the workspace tools when the host runs them (they are the caller's
 * tools like any other, whichever listing mode leaves them out of
 * tools/list). Never the other built-ins: the search is how a client gets
 * from those to a tool, not the other way round.
 */
function visibleTools(
  view: ToolBusView,
  host: BuiltinHostOptions,
): SearchableTool[] {
  const visible: SearchableTool[] = [];
  for (const tool of BUILTINS) {
    if (
      tool.kind === "host" &&
      hostRuns(tool, host) &&
      evaluateToolPolicy(tool, view.principal).action === "allow"
    ) {
      visible.push({ appId: BUILTIN_APP_ID, tool });
    }
  }
  for (const app of view.apps) {
    for (const tool of app.tools) {
      if (evaluateToolPolicy(tool, view.principal).action === "allow") {
        visible.push({ appId: app.appId, tool });
      }
    }
  }
  return visible;
}

function visibleToolCount(view: ToolBusView, app: ToolBusApp): number {
  return app.tools.filter(
    (tool) => evaluateToolPolicy(tool, view.principal).action === "allow",
  ).length;
}

const byAppThenName = (a: SearchableTool, b: SearchableTool) =>
  a.appId < b.appId
    ? -1
    : a.appId > b.appId
      ? 1
      : a.tool.name < b.tool.name
        ? -1
        : a.tool.name > b.tool.name
          ? 1
          : 0;

/**
 * How well a tool answers a query: 10 for the whole query being its listed
 * or local name, then per distinct token 5 in the name, 3 in the title, 1
 * in the description. Deterministic, so two clients asking the same thing
 * see the same order.
 */
function searchScore(
  listedName: string,
  tool: ToolBusTool,
  query: string,
  tokens: string[],
): number {
  let score = query === listedName || query === tool.name ? 10 : 0;
  const title = tool.title?.toLowerCase();
  const description = tool.description.toLowerCase();
  for (const token of tokens) {
    if (listedName.includes(token)) score += 5;
    if (title?.includes(token)) score += 3;
    if (description.includes(token)) score += 1;
  }
  return score;
}

interface SearchArguments {
  /** Trimmed and lowercased; absent when not given. */
  query?: string;
  app?: string;
  limit: number;
}

const SEARCH_FIELDS = new Set(Object.keys(SEARCH_INPUT.properties));

const isText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= max;

/**
 * The search's fields as `SEARCH_INPUT` bounds them, read again here: the
 * query is what the search runs over every tool the caller may call, so
 * its bound (and the limit's, and the closed set of fields) is this code's
 * own, whatever checked the arguments before it.
 */
function searchArguments(
  args: JsonObject,
): SearchArguments | { problem: string } {
  const unknown = Object.keys(args).find((key) => !SEARCH_FIELDS.has(key));
  if (unknown !== undefined) {
    return { problem: `\`${unknown}\` is not one of query, app, limit.` };
  }
  const query = args["query"];
  const app = args["app"];
  const limit =
    args["limit"] === undefined ? SEARCH_LIMIT_DEFAULT : args["limit"];
  if (query !== undefined && !isText(query, SEARCH_QUERY_MAX_CHARS)) {
    return {
      problem: `query must be a string of 1 to ${SEARCH_QUERY_MAX_CHARS} characters.`,
    };
  }
  if (app !== undefined && !isText(app, SEARCH_APP_MAX_CHARS)) {
    return {
      problem: `app must be a string of 1 to ${SEARCH_APP_MAX_CHARS} characters.`,
    };
  }
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > SEARCH_LIMIT_MAX
  ) {
    return {
      problem: `limit must be an integer from 1 to ${SEARCH_LIMIT_MAX}.`,
    };
  }
  return {
    ...(query !== undefined ? { query: query.trim().toLowerCase() } : {}),
    ...(app !== undefined ? { app } : {}),
    limit,
  };
}

function searchTools(
  view: ToolBusView,
  args: JsonObject,
  host: BuiltinHostOptions,
): BuiltinAnswer {
  const read = searchArguments(args);
  if ("problem" in read) return read;
  const { query, app: appId, limit } = read;
  if (query === undefined && appId === undefined) {
    return { problem: "give a query, an app id, or both." };
  }

  const candidates = visibleTools(view, host)
    .filter((entry) => appId === undefined || entry.appId === appId)
    .map((entry) => ({
      ...entry,
      name: namespacedToolName(entry.appId, entry.tool.name),
    }));
  let matched = candidates.sort(byAppThenName);
  if (query !== undefined) {
    const tokens = [...new Set(query.split(/[^\p{L}\p{N}]+/u).filter(Boolean))];
    matched = matched
      .map((entry) => ({
        entry,
        score: searchScore(entry.name, entry.tool, query, tokens),
      }))
      .filter((scored) => scored.score > 0)
      .sort((a, b) => b.score - a.score || byAppThenName(a.entry, b.entry))
      .map((scored) => scored.entry);
  }

  const found = matched.slice(0, limit).map(({ name, appId: app, tool }) => ({
    name,
    app,
    ...(tool.title ? { title: tool.title } : {}),
    description: tool.description,
    risk: tool.risk,
    inputSchema: tool.inputSchema,
  }));
  const answer = (count: number): JsonObject => ({
    tools: found.slice(0, count),
    total: matched.length,
    ...(count < found.length ? { truncated: true } : {}),
  });
  // The largest head of the list whose result stays under the byte cap,
  // found by bisection: the size grows with the count.
  let fits = found.length;
  if (resultBytes(builtinResult(answer(fits))) > SEARCH_RESULT_MAX_BYTES) {
    let low = 0;
    let high = found.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (
        resultBytes(builtinResult(answer(middle))) > SEARCH_RESULT_MAX_BYTES
      ) {
        high = middle - 1;
      } else {
        low = middle;
      }
    }
    fits = low;
  }
  return { data: answer(fits) };
}

const READ_ONLY_BUILTIN = {
  risk: "read",
  listedIn: ["full", "compact"],
  kind: "answer",
} as const;

const BUILTINS: BuiltinTool[] = [
  {
    ...READ_ONLY_BUILTIN,
    name: "list_apps",
    title: "List apps",
    description:
      "List the Every App apps this connection can use: what each is for, its URL, and how many tools it offers. Tool names are `<app>_<tool>`. An app that isn't available yet (it needs setup, or an admin hasn't turned it on) says so, with what an admin runs.",
    inputSchema: NO_INPUT,
    run: (view) => ({
      data: {
        apps: [
          ...view.apps.map((app) => ({
            id: app.appId,
            name: app.name,
            ...(app.description ? { description: app.description } : {}),
            url: app.baseUrl,
            tools: visibleToolCount(view, app),
          })),
          ...(view.unavailable ?? []).map((app) => ({
            id: app.appId,
            name: app.name,
            available: false,
            reason: app.reason,
          })),
          // Owners and admins only: the view carries none for anyone else.
          ...(view.offered ?? []).map((app) => ({
            id: app.appId,
            name: app.name,
            available: false,
            offered: true,
            reason: `off and its key is set: an admin runs ${app.command}`,
          })),
        ],
      },
    }),
  },
  {
    ...READ_ONLY_BUILTIN,
    name: "whoami",
    title: "Who am I",
    description:
      "Show who this connection acts as: the user, their organization and role, the access it was granted, and the apps it can use.",
    inputSchema: NO_INPUT,
    run: ({ principal, apps }) => ({
      data: {
        user: { email: principal.email, role: principal.orgRole },
        organization: {
          id: principal.organizationId,
          ...(principal.organizationName
            ? { name: principal.organizationName }
            : {}),
        },
        connection: {
          kind: principal.credential.kind,
          access: principal.access === "write" ? "read & write" : "read only",
          ...(principal.credential.clientName
            ? { client: principal.credential.clientName }
            : {}),
        },
        apps: apps.map((app) => app.appId),
      },
    }),
  },
  {
    ...READ_ONLY_BUILTIN,
    name: "search_tools",
    title: "Search tools",
    description:
      "Find tools this connection can call, by words, by app id, or both: each result has the tool's name (`<app>_<tool>`), what it does, whether it reads or changes data, and its input schema. Best matches first, 10 by default and 25 at most. Call a tool by that name when it is listed, else through everyapp_call_read, or everyapp_call_write for one that changes data.",
    inputSchema: SEARCH_INPUT,
    run: searchTools,
  },
  {
    name: "call_read",
    title: "Call a read tool",
    description:
      "Run one tool that only reads data, by its name (`<app>_<tool>`, from everyapp_search_tools) with its arguments. A tool that changes data is refused here; call it through everyapp_call_write.",
    risk: "read",
    inputSchema: CALL_INPUT,
    listedIn: ["compact"],
    kind: "wrapper",
    ceiling: "read",
  },
  {
    name: "call_write",
    title: "Call a write tool",
    description:
      "Run one tool by its name (`<app>_<tool>`, from everyapp_search_tools) with its arguments, including a tool that changes data.",
    risk: "write",
    inputSchema: CALL_INPUT,
    listedIn: ["compact"],
    kind: "wrapper",
    ceiling: "write",
  },
  // The workspace tools, then the provider tools, in the full listing
  // only: a compact listing's client finds them with everyapp_search_tools
  // and runs them through the wrappers, like an app's tools.
  ...[...WORKSPACE_TOOLS, ...PROVIDER_TOOLS].map((tool): BuiltinTool => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    risk: tool.risk,
    inputSchema: tool.inputSchema,
    listedIn: ["full"],
    kind: "host",
    minRole: tool.minRole,
    ...(tool.irreversible ? { irreversible: true } : {}),
    ...(tool.needs ? { needs: tool.needs } : {}),
  })),
];

/** The listed name of the wrapper that runs write tools, for messages. */
export const WRITE_WRAPPER_NAME = namespacedToolName(
  BUILTIN_APP_ID,
  "call_write",
);

function toTool(tool: BuiltinTool): Tool {
  return {
    name: namespacedToolName(BUILTIN_APP_ID, tool.name),
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema as Tool["inputSchema"],
    // Spelled out like an app tool's (server.ts): a missing hint reads as
    // true. A read wrapper runs read tools, so it is as idempotent as they
    // are; the write wrapper never reaches a destructive tool; a workspace
    // tool that cannot be undone (it asks confirm: true) says so.
    annotations:
      tool.risk === "read"
        ? { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
        : {
            readOnlyHint: false,
            destructiveHint: tool.kind === "host" && tool.irreversible === true,
            idempotentHint: false,
            openWorldHint: false,
          },
    // The core built-ins stay loaded in Claude Code, since they are how a
    // model finds its way in; the workspace tools are deferred behind its
    // tool search like an app's, so thirty admin tools don't crowd the
    // context of a client that never administers anything.
    ...(tool.kind === "host"
      ? {}
      : { _meta: { [ALWAYS_LOAD_META_KEY]: true } }),
  };
}

/**
 * The built-in tools as tools/list shows them, in a stable order: with a
 * view, those its listing mode shows to that caller (the wrappers only in
 * compact mode, `everyapp_call_write` only to a read & write caller, the
 * workspace and provider tools only in full mode, only to a caller whose
 * role reaches each tool's `minRole`, and only when the host runs them,
 * `host.workspace`, and offers what the tool needs, `host.providers`);
 * without one, every built-in the gateway has, for the docs' drift test.
 */
export function listBuiltinTools(
  view?: Pick<ToolBusView, "listing" | "principal">,
  host: BuiltinHostOptions = {},
): Tool[] {
  const mode: ListingMode = view?.listing ?? "full";
  return BUILTINS.filter(
    (tool) =>
      !view ||
      (tool.listedIn.includes(mode) &&
        (tool.kind !== "host" || hostRuns(tool, host)) &&
        evaluateToolPolicy(tool, view.principal).action === "allow"),
  ).map(toTool);
}

/** The built-in a local name (after `everyapp_`) refers to, if any. */
export function findBuiltinTool(localName: string): BuiltinTool | null {
  return BUILTINS.find((tool) => tool.name === localName) ?? null;
}

/**
 * The kind of the built-in a listed name (`everyapp_<name>`) refers to:
 * `answer` or `wrapper` for the core built-ins, `host` for a workspace
 * tool; null for any other name. For tests and the docs' drift test, which
 * document the two groups on different rows.
 */
export function builtinToolKind(listedName: string): BuiltinKind | null {
  const prefix = `${BUILTIN_APP_ID}_`;
  if (!listedName.startsWith(prefix)) return null;
  return findBuiltinTool(listedName.slice(prefix.length))?.kind ?? null;
}

function builtinResult(data: JsonObject): ToolCallResultV1 {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

/** The bytes a result takes on the wire, as the audit row counts them. */
export function resultBytes(result: ToolCallResultV1): number {
  return new TextEncoder().encode(JSON.stringify(result)).length;
}

/**
 * Run a view-answered built-in on checked arguments: its answer as JSON
 * text and as structured content, or what's wrong with the arguments.
 */
export function runBuiltinTool(
  tool: Extract<BuiltinTool, { kind: "answer" }>,
  view: ToolBusView,
  args: JsonObject,
  host: BuiltinHostOptions = {},
): { result: ToolCallResultV1 } | { problem: string } {
  const answer = tool.run(view, args, host);
  return "problem" in answer ? answer : { result: builtinResult(answer.data) };
}
