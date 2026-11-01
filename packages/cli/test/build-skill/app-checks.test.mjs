/**
 * The build-skill harness's readers (app-checks.mjs): the tools a
 * src/tools.ts defines, the diff's added code lines, the forbidden
 * patterns, and when the skill was read against when the first edit
 * happened. Runs in CI with the CLI's tests; the harness itself does not.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AUTH_PATTERN,
  CLIENT_HEADER_PATTERN,
  PATTERNS_FILE,
  SKILL_FILE,
  addedCodeLines,
  appNameFor,
  cloudflareCalls,
  findForbidden,
  firstRead,
  firstWrite,
  parseDiff,
  toolsDefined,
} from "./app-checks.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const starterTools = fs.readFileSync(path.join(here, "..", "..", "..", "..", "starter", "src", "tools.ts"), "utf8");

describe("toolsDefined", () => {
  it("reads the starter's four tools and their risks", () => {
    expect(toolsDefined(starterTools)).toEqual([
      { name: "list_todos", risk: "read" },
      { name: "create_todo", risk: "write" },
      { name: "update_todo", risk: "write" },
      { name: "delete_todo", risk: "destructive" },
    ]);
  });

  it("sees a tool without a risk, braces in strings, comments and a quoted name", () => {
    const source = `
      import { defineTools } from "@every-app/sdk/server";
      export const tools = defineTools(
        {
          // a comment with a brace: {
          list_notes: { description: "List notes { all of them }", risk: "read", input: z.object({}), handler: () => [] },
          "add_note": { description: \`Add one }\`, risk: 'write', handler: (i) => ({ ...i }) },
          forgot_risk: { description: "No risk here", handler: () => null },
        },
        { instructions: "risk: \\"read\\" in the instructions is not a tool" },
      );
    `;
    expect(toolsDefined(source)).toEqual([
      { name: "list_notes", risk: "read" },
      { name: "add_note", risk: "write" },
      { name: "forgot_risk", risk: null },
    ]);
  });

  it("is null without a defineTools call", () => {
    expect(toolsDefined("export const tools = {};")).toBeNull();
  });
});

describe("the diff", () => {
  const diff = [
    "diff --git a/pristine/src/db/schema.ts b/after/src/db/schema.ts",
    "index 1..2 100644",
    "--- a/pristine/src/db/schema.ts",
    "+++ b/after/src/db/schema.ts",
    "@@ -1,2 +1,4 @@",
    " import { sql } from \"drizzle-orm\";",
    "+// a comment about the session",
    "+export const notes = sqliteTable(\"notes\", {",
    "-old line",
    "diff --git a/pristine/src/server/notes.ts b/after/src/server/notes.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/after/src/server/notes.ts",
    "@@ -0,0 +1,2 @@",
    "+const who = request.headers.get(\"x-user-email\");",
    "+const token = jwt.verify(password);",
    "diff --git a/pristine/README.md b/after/README.md",
    "--- a/pristine/README.md",
    "+++ b/after/README.md",
    "+No login of its own: the Gateway signs people in.",
    // A deleted file's b/ side still names the first snapshot (git diff --no-index does this).
    "diff --git a/pristine/src/old.ts b/pristine/src/old.ts",
    "deleted file mode 100644",
    "--- a/pristine/src/old.ts",
    "+++ /dev/null",
    "-gone",
  ].join("\n");

  it("parses files, statuses and added lines", () => {
    const files = parseDiff(diff);
    expect(files.map((f) => [f.path, f.status, f.added.length, f.removed])).toEqual([
      ["src/db/schema.ts", "modified", 2, 1],
      ["src/server/notes.ts", "added", 2, 0],
      ["README.md", "modified", 1, 0],
      ["src/old.ts", "deleted", 0, 1],
    ]);
  });

  it("keeps only added code lines: no comments, no markdown", () => {
    expect(addedCodeLines(parseDiff(diff)).map((l) => l.line)).toEqual([
      'export const notes = sqliteTable("notes", {',
      'const who = request.headers.get("x-user-email");',
      "const token = jwt.verify(password);",
    ]);
  });

  it("finds a login and a header read in code, not in a comment or the README", () => {
    const files = parseDiff(diff);
    expect(findForbidden(files, AUTH_PATTERN).map((h) => h.line)).toEqual(["const token = jwt.verify(password);"]);
    expect(findForbidden(files, CLIENT_HEADER_PATTERN).map((h) => h.line)).toEqual(['const who = request.headers.get("x-user-email");']);
  });

  it("lets the starter's own words through", () => {
    for (const line of ["const user = await requireEveryAppUser(getRequest(), env);", "handler: (_input, { user }) => todos.listTodos(user.id),", "userId: text(\"user_id\").notNull(),"]) {
      expect(AUTH_PATTERN.test(line)).toBe(false);
      expect(CLIENT_HEADER_PATTERN.test(line)).toBe(false);
    }
  });
});

describe("reads and writes in the session", () => {
  const app = "/tmp/run/every-app/apps/team-notes";
  const uses = [
    { seq: 1, name: "Read", input: { file_path: `${app}/AGENTS.md` } },
    { seq: 2, name: "Skill", input: { skill: "build-every-app" } },
    { seq: 3, name: "Bash", input: { command: "pnpm test 2>&1 | tail -5" } },
    { seq: 4, name: "Bash", input: { command: `sed -n 1,80p ${app}/.claude/skills/build-every-app/patterns.md` } },
    { seq: 5, name: "Bash", input: { command: "cat > src/db/schema.ts <<'EOF'\nexport {}\nEOF" } },
    { seq: 6, name: "Edit", input: { file_path: `${app}/src/tools.ts` } },
    { seq: 7, name: "Read", input: { file_path: `${app}/.agents/skills/build-every-app/SKILL.md` } },
  ];

  it("counts the Skill tool as reading SKILL.md, and a sed as reading patterns.md", () => {
    expect(firstRead(uses, { file: SKILL_FILE, skill: "build-every-app" })?.seq).toBe(2);
    expect(firstRead(uses, { file: SKILL_FILE })?.seq).toBe(7);
    expect(firstRead(uses, { file: PATTERNS_FILE })?.seq).toBe(4);
    expect(firstRead(uses, { file: /nowhere\.md$/ })).toBeNull();
  });

  it("counts a grep of patterns.md in the middle of a command (run 2 read it that way)", () => {
    const grep = {
      seq: 3,
      name: "Bash",
      input: { command: 'cat src/routes/index.tsx; grep -n -i -B2 -A12 "organization-wide\\|orgId" .agents/skills/build-every-app/patterns.md | head -80; cat package.json' },
    };
    expect(firstRead([uses[0], grep, uses[5]], { file: PATTERNS_FILE })?.seq).toBe(3);
    expect(firstRead([uses[0], grep, uses[5]], { file: SKILL_FILE })).toBeNull();
  });

  it("takes a redirect as the first write, not a 2>&1", () => {
    expect(firstWrite(uses)?.seq).toBe(5);
    expect(firstWrite(uses.filter((u) => u.seq !== 5))?.seq).toBe(6);
    expect(firstWrite(uses.slice(0, 4))).toBeNull();
  });

  it("takes a rm as a write (run 1 deleted the todos before reading patterns.md)", () => {
    const rm = { seq: 3, name: "Bash", input: { command: "rm -rf src/server/todos.ts drizzle/0000_todos.sql" } };
    expect(firstWrite([uses[0], uses[1], rm, uses[5]])?.seq).toBe(3);
  });
});

describe("cloudflareCalls", () => {
  it("flags a cf deploy and a wrangler call, not --version, the passthrough or curl", () => {
    // The stubs' log, as shared/tool-stubs.mjs writes it: the tool is the second word.
    const log = [
      "2026-10-25T01:02:03Z cf --version",
      "2026-10-25T01:02:04Z cf workers types",
      "2026-10-25T01:02:05Z cf deploy --prebuilt",
      "2026-10-25T01:02:06Z cloudflare workers types --config x",
      "2026-10-25T01:02:07Z wrangler deploy",
      "2026-10-25T01:02:08Z curl http://localhost:5173/health",
    ];
    expect(cloudflareCalls(log, ["workers types"])).toEqual(["cf deploy --prebuilt", "wrangler deploy"]);
    expect(cloudflareCalls(log)).toEqual(["cf workers types", "cf deploy --prebuilt", "cloudflare workers types --config x", "wrangler deploy"]);
    expect(cloudflareCalls([])).toEqual([]);
  });
});

describe("appNameFor", () => {
  it("spells the id as create does", () => {
    expect(appNameFor("team-notes")).toBe("Team Notes");
    expect(appNameFor("crm2")).toBe("Crm2");
  });
});
