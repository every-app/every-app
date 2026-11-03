/**
 * The errors page of the agent docs (errors.md), generated from the codes
 * the source defines (codes.ts): one `### CODE` heading per code, so its
 * anchor is the code, and under it one line. The lines are the page's own:
 * regenerating keeps each code's line, gives a new code a pointer to where
 * it is raised, and drops a code the source no longer has.
 */
import { codeInventory } from "./codes";

interface Section {
  title: string;
  intro: string;
  /** Code → where it is raised, for a code the page has no line for yet. */
  codes: Map<string, string>;
  /** Appended to a heading whose code an earlier section has already. */
  suffix?: string;
}

const CLI_SRC = "packages/cli/src/";
const GATEWAY_DEPLOY = "apps/every-app-gateway/src/server/deploy/";

/** The one line under each heading of the page as it stands, by heading. */
function linesOf(page: string): Map<string, string> {
  const lines = new Map<string, string>();
  const parts = page.split(/^(#{2,3} .+)$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const heading = parts[i]!;
    if (!heading.startsWith("### ")) continue;
    const text = parts[i + 1]!.trim().replace(/\s*\n\s*/g, " ");
    if (text) lines.set(heading.slice(4).trim(), text);
  }
  return lines;
}

const sorted = (codes: Iterable<string>) => [...new Set(codes)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

function sites(map: Map<string, Set<string>>, code: string, root: string): string {
  const where = [...(map.get(code) ?? [])].map((file) => `\`${root}${file}\``);
  return where.length > 0 ? `Raised in ${where.join(", ")}.` : "";
}

export function errorsPage(current: string): string {
  const inventory = codeInventory();
  const lines = linesOf(current);

  const errors = new Map<string, string>();
  for (const code of inventory.argument) errors.set(code, "An argument error (exit 251 or 252).");
  for (const code of inventory.reporter) errors.set(code, "Given by `packages/cli/src/lib/output/report.ts`.");
  for (const code of inventory.registry) errors.set(code, "A registry rule, `packages/perimeter/src/registry/registration.ts`.");
  for (const code of inventory.errors.keys()) errors.set(code, sites(inventory.errors, code, CLI_SRC));
  for (const code of inventory.warnings.keys()) {
    if (!errors.has(code)) errors.set(code, sites(inventory.warnings, code, CLI_SRC));
  }
  const hosted = new Map<string, string>();
  for (const code of inventory.hostedApi.keys()) {
    if (!errors.has(code)) hosted.set(code, sites(inventory.hostedApi, code, GATEWAY_DEPLOY));
  }
  const status = new Map<string, string>();
  for (const code of inventory.status) status.set(code, "Reported by `packages/cli/src/commands/status/problems.ts`.");

  const sections: Section[] = [
    {
      title: "Errors and warnings",
      intro:
        "An `error` event ends the run, with `code`, `message`, `retryable` and in `data` maybe `fix` (a remedy in words), `rerun` (the command to run next, `rerunNote` after it) and `authorize: true` (ask the person before running the rerun: it adds a takeover flag). A `warning` event is something the run went on past. [The protocol](/docs/agent/json)",
      codes: errors,
    },
    {
      title: "The Gateway's deploy API",
      intro:
        "Answered as `{ \"error\": \"<code>\", \"message\": \"…\" }` by the hosted deploy API and by Gateway app installs (Admin → Apps → Install app); no everyapp command calls them.",
      codes: hosted,
    },
    {
      title: "What status reports",
      intro:
        "`everyapp status` lists each problem in `data.fixes[]` as `{ code, severity, message, run, note?, fix? }`: run `run` when it isn't `null`. See [status](/docs/agent/status).",
      codes: status,
      suffix: " (status)",
    },
  ];

  const out: string[] = [
    "---",
    "title: Error codes",
    'description: "Every code an everyapp command, the Gateway deploy API or everyapp status can report, one line each: what it means and what to do."',
    "---",
    "",
    "<!-- The headings are generated from the source by packages/cli/src/docs/errorsPage.ts (`pnpm -C packages/cli docs:update`); the line under each is written here and kept. -->",
    "",
    "Codes are stable; messages are for people and say more. An entry's anchor is its code in lowercase (`/docs/agent/errors#deploy_failed`). Suggested commands are written `everyapp …`; a real message uses the invocation that started it (`pnpm everyapp` in a checkout). When a line isn't enough, read the message, then the source that raises the code.",
  ];
  const used = new Set<string>();
  for (const section of sections) {
    if (section.codes.size === 0) continue;
    out.push("", `## ${section.title}`, "", section.intro, "");
    for (const code of sorted(section.codes.keys())) {
      const heading = used.has(code) && section.suffix ? `${code}${section.suffix}` : code;
      used.add(code);
      const line = lines.get(heading) ?? (section.codes.get(code) || "No description yet.");
      out.push(`### ${heading}`, line);
    }
  }
  return `${out.join("\n").trimEnd()}\n`;
}
