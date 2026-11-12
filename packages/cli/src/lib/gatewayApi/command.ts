/**
 * A command that is one Gateway tool (lib/gatewayApi): its flags become
 * the tool's arguments, the tool's answer is the `done` event's `data`
 * under --json, and a person sees it drawn as facts and tables. Nothing
 * here knows what a tool does; the Gateway's services decide everything.
 */
import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";
import type { EventSink } from "@/lib/output/events";
import { canPromptInTerminal, confirmUnlessYes } from "@/lib/output/prompt";
import { finish } from "@/lib/output/result";
import { runCommand } from "@/lib/output/run";
import { formatFacts, formatTable } from "@/lib/output/table";
import { openGatewayApi, type GatewayApi, type GatewayApiFlags, type JsonObject } from ".";

export interface ToolCommandFlags extends GatewayApiFlags {
  verbose?: boolean;
}

/** A command whose tool asks first (`ToolRun.confirm`). */
type ConfirmFlags = ToolCommandFlags & { yes?: boolean };

export interface ToolRun {
  /** The tool's full name (`everyapp_workspace_users`). */
  tool: string;
  args?: JsonObject;
  /** The line `done` says; the tool's name when left out. */
  done?: (answer: JsonObject) => string;
  /** What a person sees under it; the answer drawn generically when left out, nothing when it returns "". */
  display?: (answer: JsonObject) => string;
  /** The short form a person sees in place of `done`'s line (docs/cli-output.md); null keeps the line. */
  short?: (answer: JsonObject) => { headline: string; blocks?: string[][]; detail?: string[] } | null;
  /** Ask first (the tool can't be undone): `--yes` skips it; unattended without it is CONFIRMATION_REQUIRED. */
  confirm?: string;
}

/** Tests: open the API some other way. */
export type OpenApi = (flags: GatewayApiFlags, out: EventSink) => Promise<GatewayApi>;

const defaultOpen: OpenApi = (flags, out) => openGatewayApi({ flags, out });

/** Run one tool for a command, and say what it answered. */
export async function runTool(
  flags: ConfirmFlags,
  run: ToolRun | ((api: GatewayApi, out: EventSink) => Promise<ToolRun>),
  open: OpenApi = defaultOpen,
): Promise<void> {
  await runCommand(flags, async (out) => {
    const api = await open(flags, out);
    const step = typeof run === "function" ? await run(api, out) : run;
    await callAndReport(api, out, flags, step);
  });
}

/** Call `run.tool` on `api` and emit its `done`. */
export async function callAndReport(api: GatewayApi, out: EventSink, flags: ConfirmFlags, run: ToolRun): Promise<JsonObject> {
  if (run.confirm) {
    await confirmUnlessYes({
      yes: flags.yes,
      interactive: canPromptInTerminal(flags.json ?? false),
      question: run.confirm,
      unattended: `${run.confirm} Nobody is at a terminal to say yes: pass --yes.`,
    });
  }
  const answer = await api.call(run.tool, run.args ?? {});
  const line = run.done ? run.done(answer) : `${run.tool} answered.`;
  const display = run.display ? run.display(answer) : formatAnswer(answer);
  const short = run.short?.(answer);
  if (short) {
    finish(out, {
      ...short,
      blocks: [...(short.blocks ?? []), ...(display ? [[display]] : [])],
      message: [stripVTControlCharacters(line)],
      data: { gateway: api.gateway, tool: run.tool, ...answer },
    });
    return answer;
  }
  out.emit({
    type: "done",
    message: stripVTControlCharacters(line),
    display: [line, ...(display ? ["", display] : [])].join("\n"),
    data: { gateway: api.gateway, tool: run.tool, ...answer },
  });
  return answer;
}

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A cell: scalars as they are, lists joined, objects as compact JSON. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return chalk.dim("—");
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.every((item) => !isObject(item) && !Array.isArray(item))) {
    return value.length ? value.map(String).join(", ") : chalk.dim("—");
  }
  return JSON.stringify(value);
}

/** Rows of objects as a table, the columns every row's keys in order. */
export function formatRows(rows: readonly JsonObject[]): string {
  if (rows.length === 0) return chalk.dim("(none)");
  const columns: string[] = [];
  for (const row of rows) for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  return formatTable(
    columns,
    rows.map((row) => columns.map((column) => cell(row[column]))),
  ).join("\n");
}

/**
 * A tool's answer for a person: its scalar fields as facts (a nested
 * object's one level down, `a.b`), then each list of objects as a table
 * under its name.
 */
export function formatAnswer(answer: JsonObject): string {
  const facts: { label: string; value: string }[] = [];
  const tables: string[] = [];
  const visit = (key: string, value: unknown, depth: number) => {
    if (Array.isArray(value) && value.some(isObject)) {
      tables.push([chalk.bold(key), formatRows(value.filter(isObject))].join("\n"));
    } else if (isObject(value) && depth === 0) {
      for (const [inner, innerValue] of Object.entries(value)) visit(`${key}.${inner}`, innerValue, depth + 1);
    } else {
      facts.push({ label: key, value: cell(value) });
    }
  };
  for (const [key, value] of Object.entries(answer)) visit(key, value, 0);
  return [...(facts.length ? [formatFacts(facts).join("\n")] : []), ...tables].join("\n\n");
}

/** `--add`, `--remove`, `--set`: a list change as the `*_set` tools take it, or null for none. */
export function listChange(
  flags: { add?: readonly string[]; remove?: readonly string[]; set?: readonly string[] },
  fullKey: "users" | "apps",
): JsonObject | null {
  const { add, remove, set } = flags;
  if (set?.length) return { [fullKey]: [...set], ...(add?.length ? { add: [...add] } : {}), ...(remove?.length ? { remove: [...remove] } : {}) };
  if (!add?.length && !remove?.length) return null;
  return { ...(add?.length ? { add: [...add] } : {}), ...(remove?.length ? { remove: [...remove] } : {}) };
}
