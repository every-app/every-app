/**
 * The agent pages generated from the build-every-app skill
 * (packages/cli/skills/build-every-app): build.md from SKILL.md and
 * patterns.md from patterns.md, so the skill every created app carries and
 * the page at everyapp.com/docs/agent/build are one text. The test in
 * agentDocs.test.ts compares each page to what this generates; UPDATE_DOCS
 * rewrites them (`pnpm -C packages/cli docs:update`).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SKILL_DIR = new URL("../../skills/build-every-app/", import.meta.url);

/** The skill's files as the repository holds them, and the one the preface names. */
export const BUILD_SKILL = {
  name: "build-every-app",
  skill: "packages/cli/skills/build-every-app/SKILL.md",
  patterns: "packages/cli/skills/build-every-app/patterns.md",
  /** Where `everyapp create` puts the skill in an app (also under `.claude/skills/`). */
  inApp: ".agents/skills/build-every-app",
} as const;

function readSkillFile(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, SKILL_DIR)), "utf8");
}

/** The frontmatter fields of a skill file and the body after it. */
function splitFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { fields, body: text.slice(match[0].length) };
}

/** The body without its H1 (the page's frontmatter title stands for it) and surrounding blank lines. */
function withoutTitle(body: string): string {
  return body.replace(/^\s*# [^\n]*\n/, "").replace(/^\n+/, "").replace(/\s+$/, "");
}

function frontmatter(title: string, description: string): string {
  return `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---`;
}

function generatedNote(source: string): string {
  return `<!-- Generated from ${source} by packages/cli/src/docs/skillPages.ts; the test in packages/cli/src/docs/agentDocs.test.ts fails when this page is stale. Regenerate with \`pnpm -C packages/cli docs:update\`. -->`;
}

/**
 * build.md: the skill's SKILL.md as a page. The skill names its patterns
 * index as the file beside it; on the page that is a link to the patterns
 * page, and the paths it gives stay as written.
 */
export function buildPage(): string {
  const { fields, body } = splitFrontmatter(readSkillFile("SKILL.md"));
  const description = fields["description"];
  if (!description) throw new Error(`${BUILD_SKILL.skill} has no description in its frontmatter`);
  const text = withoutTitle(body).replace(/`patterns\.md`/g, "[patterns.md](/docs/agent/patterns)");
  return [
    frontmatter("Build an app", description),
    "",
    generatedNote(BUILD_SKILL.skill),
    "",
    `This page is the \`${BUILD_SKILL.name}\` skill (\`${BUILD_SKILL.skill}\` in the checkout), which \`pnpm everyapp create\` copies into every new app at \`${BUILD_SKILL.inApp}\` and \`.claude/skills/${BUILD_SKILL.name}\`; its patterns index is [Example patterns](/docs/agent/patterns). An agent working in an app reads the copy there. The everyapp skill it names is \`packages/cli/skills/everyapp/SKILL.md\` (in an app \`.agents/skills/everyapp\`); its pages here are [cli](/docs/agent/cli), [json](/docs/agent/json) and [setup](/docs/agent/setup).`,
    "",
    text,
    "",
  ].join("\n");
}

/** patterns.md: the skill's patterns index as a page. */
export function patternsPage(): string {
  const body = withoutTitle(readSkillFile("patterns.md"));
  return [
    frontmatter(
      "Example patterns",
      "How the apps on Every App do each thing and the file to copy from, in the starter or one of the four open apps: identity, public routes, every manifest field, email, AI, agents and Workflows, tools, needs setup, cookies and the bundle, tests, dev vs production, release and install.",
    ),
    "",
    generatedNote(BUILD_SKILL.patterns),
    "",
    `This page is \`patterns.md\` of the \`${BUILD_SKILL.name}\` skill (\`${BUILD_SKILL.patterns}\` in the checkout; in an app \`${BUILD_SKILL.inApp}/patterns.md\`), the index [Build an app](/docs/agent/build) reads before the first edit. Each app's repository is \`https://github.com/every-app/<name>\`; clone it beside the app to read a file.`,
    "",
    body,
    "",
  ].join("\n");
}
