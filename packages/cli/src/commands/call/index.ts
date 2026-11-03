/**
 * `everyapp call <tool> [json]` and `everyapp call --list`: any tool on
 * the Gateway's `/mcp`, as the signed-in person (lib/gatewayApi).
 */
import { EveryAppError } from "@/lib/errors";
import { formatTable } from "@/lib/output/table";
import { runCommand } from "@/lib/output/run";
import { callAndReport, type OpenApi, type ToolCommandFlags } from "@/lib/gatewayApi/command";
import { openGatewayApi, type JsonObject } from "@/lib/gatewayApi";

interface CallFlags extends ToolCommandFlags {
  list?: boolean;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

/** The arguments: one JSON object (`-` from stdin), or none. */
export async function parseArguments(raw: string | undefined, stdin: () => Promise<string> = readStdin): Promise<JsonObject> {
  if (raw === undefined || raw.trim() === "") return {};
  const text = raw.trim() === "-" ? await stdin() : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new EveryAppError("INVALID_VALUE", `The tool's arguments must be one JSON object, like '{"email":"ann@example.com"}'`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new EveryAppError("INVALID_VALUE", "The tool's arguments must be a JSON object, not an array or a value");
  }
  return parsed as JsonObject;
}

export async function call(
  flags: CallFlags,
  tool?: string,
  json?: string,
  open: OpenApi = (apiFlags, out) => openGatewayApi({ flags: apiFlags, out }),
): Promise<void> {
  await runCommand(flags, async (out) => {
    if (!flags.list && !tool) {
      throw new EveryAppError("INVALID_VALUE", "Name a tool to call, or pass --list to see them");
    }
    const args = flags.list ? {} : await parseArguments(json);
    const api = await open(flags, out);
    if (flags.list) {
      const tools = await api.list();
      const rows = tools.map((listed) => [
        listed.name,
        listed.annotations?.["readOnlyHint"] === true ? "read" : "write",
        listed.title ?? "",
      ]);
      out.emit({
        type: "done",
        message: `${tools.length} tools on ${api.gateway}`,
        display: [`${tools.length} tools on ${api.gateway}`, "", ...formatTable(["TOOL", "RISK", "TITLE"], rows)].join("\n"),
        data: { gateway: api.gateway, tools: tools.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })) },
      });
      return;
    }
    await callAndReport(api, out, flags, {
      tool: tool!,
      args,
      done: () => `${tool} on ${api.gateway}`,
      display: (answer) => (typeof answer["text"] === "string" && Object.keys(answer).length === 1 ? answer["text"] : JSON.stringify(answer, null, 2)),
    });
  });
}
