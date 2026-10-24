/**
 * The agent docs (landing-page/content/agent) against the code they
 * describe. A generated page is compared to what the source generates; a
 * hand-written page must name, in backticks, every identifier the source
 * defines for its subject: a new command, flag, error code, warning,
 * manifest field, Gateway setting, header or SDK export fails here until it
 * is documented. To regenerate the generated pages:
 *
 *   pnpm -C packages/cli docs:update
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as sdkServer from "@every-app/sdk/server";
import {
  DEV_ONLY_GATEWAY_SETTINGS,
  IDENTITY_DEV_KEY_ID,
  IDENTITY_HEADER,
  IDENTITY_KEY_ID,
  INSTALL_OWNED_GATEWAY_SETTINGS,
  ORG_HEADER,
  PUBLIC_HEADER,
  SETTABLE_GATEWAY_SETTINGS,
  SYSTEM_HEADER,
  GATEWAY_ERROR_HEADER,
  APP_ID_ENV,
  AUDIENCE_ENV,
  PUBLIC_KEYS_ENV,
  ISSUER_ENV,
  SHARED_ENV,
  DEV_ENV,
  DEV_ISSUER,
} from "@every-app/sdk/internal";
import { listBuiltinTools } from "@every-app/toolbus";
import { cliReference, commandDocs } from "./cliReference";
import { codeInventory } from "./codes";
import { manifestFields } from "./manifestFields";
import {
  AGENT_DOCS_DIR,
  UPDATE_DOCS,
  anchorOf,
  backticked,
  h3s,
  mirroredDocuments,
  readPage,
  writePage,
} from "./pages";


const HOW = "Document it on the page (see the brief at the top of the page), or run `pnpm -C packages/cli docs:update` for a generated page.";

/**
 * The Gateway connector's built-in tools (`everyapp_whoami`, …) from the code
 * that lists them, so a new built-in fails here until the docs name it.
 */
const BUILTIN_TOOLS = listBuiltinTools().map((tool) => tool.name);
const BUILTINS_WHAT = "the built-in tools of the Gateway connector (listBuiltinTools in packages/toolbus/src/builtins.ts)";

/** The identifiers of `expected` that `page` doesn't have in backticks. */
function missingFrom(page: string, expected: Iterable<string>): string[] {
  const found = backticked(page);
  return [...expected].filter((id) => !found.has(id));
}

function expectDocumented(slug: string, what: string, expected: Iterable<string>): void {
  const missing = missingFrom(readPage(slug), expected);
  expect(
    missing,
    `${slug}.md doesn't document ${what}: ${missing.join(", ")}. ${HOW}`,
  ).toEqual([]);
}

/** Every flag of the commands whose route starts with `prefix`, as `--flag`. */
function flagsOf(...prefixes: string[]): string[] {
  const names = new Set<string>();
  for (const doc of commandDocs()) {
    if (!prefixes.some((prefix) => doc.path === prefix || doc.path.startsWith(`${prefix} `))) continue;
    for (const flag of doc.flags) names.add(`--${flag.name}`);
  }
  return [...names];
}

describe("the agent docs", () => {
  const slugs = () =>
    readdirSync(fileURLToPath(AGENT_DOCS_DIR))
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.replace(/\.md$/, ""));

  it("has every page the index and the sidebar name", () => {
    for (const slug of [
      "index",
      "setup",
      "cli",
      "json",
      "errors",
      "troubleshooting",
      "manifest",
      "identity",
      "secrets",
      "dev",
      "email",
      "mcp",
      "deploy",
      "access",
    ]) {
      expect(slugs(), `${slug}.md`).toContain(slug);
    }
  });

  it("links only to pages that exist", () => {
    const userDocs = new URL("../docs/", AGENT_DOCS_DIR);
    const broken: string[] = [];
    for (const slug of slugs()) {
      const page = readPage(slug);
      for (const match of page.matchAll(/\]\((\/docs(?:\/agent)?(?:\/[a-z0-9-]+)*)(#[^)]*)?\)/g)) {
        const [, target] = match;
        const rest = target!.replace(/^\/docs\/agent\/?/, "").replace(/^\/docs\/?/, "");
        const isAgent = target!.startsWith("/docs/agent");
        if (rest.startsWith("repo/")) {
          // Mirrored from the repository at build time: the source must exist,
          // or the site build's prerender fails on the link.
          const source = mirroredDocuments().get(rest.slice("repo/".length));
          if (!source || !existsSync(fileURLToPath(new URL(`../../../${source}`, AGENT_DOCS_DIR)))) {
            broken.push(`${slug}.md → ${target} (not mirrored, or its source is missing)`);
          }
          continue;
        }
        const dir = isAgent ? AGENT_DOCS_DIR : userDocs;
        const file = rest === "" ? "index" : rest;
        const exists = [".md", ".mdx"].some((ext) =>
          existsSync(fileURLToPath(new URL(`${file}${ext}`, dir))),
        );
        if (!exists) broken.push(`${slug}.md → ${target}`);
      }
    }
    expect(broken, "links to pages that don't exist").toEqual([]);
  });

  it("links error codes to headings that exist", () => {
    const errorsPage = readPage("errors");
    const anchors = new Set(
      [...h3s(errorsPage), ...[...errorsPage.matchAll(/^## (.+)$/gm)].map((m) => m[1]!.trim())].map(
        anchorOf,
      ),
    );
    const broken: string[] = [];
    for (const slug of slugs()) {
      for (const match of readPage(slug).matchAll(/\]\(\/docs\/agent\/errors#([^)]+)\)/g)) {
        if (!anchors.has(match[1]!)) broken.push(`${slug}.md → #${match[1]}`);
      }
    }
    expect(broken, "anchors into errors.md that don't exist").toEqual([]);
  });
});

describe("cli.md", () => {
  it("is what the commands generate", () => {
    const generated = cliReference();
    if (UPDATE_DOCS) {
      writePage("cli", generated);
      return;
    }
    expect(
      readPage("cli"),
      "cli.md is out of date with the commands: run `pnpm -C packages/cli docs:update` and commit the result",
    ).toBe(generated);
  });
});

describe("errors.md", () => {
  const inventory = codeInventory();
  const headings = () => h3s(readPage("errors"));
  const codes = () =>
    new Set(headings().map((heading) => heading.replace(/ \(status\)$/, "")));

  it("has a heading for every code the CLI raises", () => {
    const documented = codes();
    const missing = [...inventory.errors.keys()].filter((code) => !documented.has(code));
    expect(missing, `error codes without a \`### CODE\` heading in errors.md (raised in ${missing.map((code) => [...inventory.errors.get(code)!].join("/")).join("; ")}). ${HOW}`).toEqual([]);
  });

  it("has a heading for every code the reporter and the argument parser give", () => {
    const documented = codes();
    const missing = [...inventory.reporter, ...inventory.argument].filter(
      (code) => !documented.has(code),
    );
    expect(missing, `codes without a heading in errors.md. ${HOW}`).toEqual([]);
  });

  it("has a heading for every warning", () => {
    const documented = codes();
    const missing = [...inventory.warnings.keys()].filter((code) => !documented.has(code));
    expect(missing, `warning codes without a heading in errors.md. ${HOW}`).toEqual([]);
  });

  it("has a heading for every problem status reports", () => {
    const documented = codes();
    const missing = inventory.status.filter((code) => !documented.has(code));
    expect(missing, `status problem codes without a heading in errors.md. ${HOW}`).toEqual([]);
  });

  it("has a heading for every code a hosted Gateway's deploy API answers", () => {
    const documented = codes();
    const missing = [...inventory.hostedApi.keys()].filter((code) => !documented.has(code));
    expect(missing, `hosted deploy API codes without a heading in errors.md. ${HOW}`).toEqual([]);
  });

  it("documents no code the source no longer has", () => {
    const known = new Set([
      ...inventory.errors.keys(),
      ...inventory.reporter,
      ...inventory.argument,
      ...inventory.warnings.keys(),
      ...inventory.status,
      ...inventory.hostedApi.keys(),
    ]);
    const stale = headings().filter((heading) => {
      const code = heading.replace(/ \(status\)$/, "");
      return !known.has(code) && !/^HTTP_nnn$/.test(code);
    });
    expect(stale, "headings in errors.md for codes the source doesn't define (remove or rename them)").toEqual([]);
  });

  it("names the person's actions", () => {
    expectDocumented("json", "every action_required action", inventory.actions);
    expectDocumented("setup", "every action_required action", inventory.actions);
  });
});

describe("json.md", () => {
  it("documents every event type, data field and exit code", () => {
    expectDocumented("json", "the event types", ["step", "progress", "warning", "action_required", "error", "done"]);
    expectDocumented("json", "the event data fields", [
      "rerun",
      "rerunNote",
      "fix",
      "url",
      "code",
      "authorize",
      "waiting",
      "choices",
      "rollbackCommand",
      "didYouMean",
      "usage",
      "help",
      "stack",
      "next",
      "durationMs",
      "expiresAt",
      "waitingFor",
      "retryable",
    ]);
    expectDocumented("json", "the exit codes", ["0", "1", "2", "130", "251", "252"]);
  });
});

describe("manifest.md", () => {
  const fields = manifestFields();
  it("documents every field of everyapp.config.ts", () => {
    expectDocumented("manifest", "these manifest fields", fields.paths);
  });
  it("documents every value the manifest's enums take", () => {
    expectDocumented("manifest", "these enum values", fields.values);
  });
});

describe("identity.md", () => {
  it("documents the headers, env vars, key ids and issuer", () => {
    expectDocumented("identity", "the headers an app receives", [
      IDENTITY_HEADER,
      PUBLIC_HEADER,
      SYSTEM_HEADER,
      ORG_HEADER,
      GATEWAY_ERROR_HEADER,
    ]);
    expectDocumented("identity", "the env vars a Worker gets", [
      APP_ID_ENV,
      AUDIENCE_ENV,
      PUBLIC_KEYS_ENV,
      ISSUER_ENV,
      SHARED_ENV,
      DEV_ENV,
      "EVERYAPP_BUILD",
      "EVERY_APP_GATEWAY",
      "EVERY_APP_ORG_ID",
      "GATEWAY_URL",
      "DATABASE_PROVIDER",
      "EVERYAPP_EMAIL_SENDERS",
    ]);
    expectDocumented("identity", "the key ids and the dev issuer", [IDENTITY_KEY_ID, IDENTITY_DEV_KEY_ID, DEV_ISSUER]);
    expectDocumented("identity", "the token's claims", ["typ", "email", "org_id", "org_role", "chan", "act", "scopes", "jti", "tc", "aud", "iss", "sub", "exp", "iat"]);
    expectDocumented("identity", "the channels", ["web", "api", "mcp", "agent"]);
  });
  it("documents every export of @every-app/sdk/server", () => {
    expectDocumented("identity", "these exports of @every-app/sdk/server", Object.keys(sdkServer));
  });
});

describe("secrets.md", () => {
  it("documents every Gateway setting", () => {
    expectDocumented("secrets", "the settable Gateway settings", SETTABLE_GATEWAY_SETTINGS);
    expectDocumented("secrets", "the install-owned Gateway settings", INSTALL_OWNED_GATEWAY_SETTINGS);
    expectDocumented("secrets", "the dev-only Gateway settings", DEV_ONLY_GATEWAY_SETTINGS);
    expectDocumented("secrets", "the reserved app secret names", ["GATEWAY_URL", "CF_VERSION_METADATA", "EVERYAPP_", "EVERY_APP_", "APP__"]);
    expectDocumented("secrets", "the secrets file and its variables", [".everyapp/secrets.env", "POSTGRES_DATABASE_URL", ".dev.vars", "--from-env"]);
  });
  it("documents every secret flag", () => {
    expectDocumented("secrets", "the flags of everyapp secret", flagsOf("secret"));
  });
});

describe("the command pages", () => {
  it("dev.md documents every flag of everyapp dev", () => {
    expectDocumented("dev", "the flags of everyapp dev", flagsOf("dev"));
    expectDocumented("dev", "the modes", ["stub", "mirror", "EVERYAPP_DEV_MODE", "everyapp.localhost", "8787", DEV_ENV, ".dev.vars"]);
  });
  it("email.md documents every flag of everyapp email", () => {
    expectDocumented("email", "the flags of everyapp email", flagsOf("email"));
    expectDocumented("email", "the email settings", ["EMAIL_FROM", "EMAIL_FROM_NAME", "EMAIL_PROVIDER", "RESEND_API_KEY", "EMAIL_REST_API_TOKEN", "EVERYAPP_EMAIL_SENDERS", "sendEmail", "capabilities.email", "email.inbound"]);
  });
  it("deploy.md documents every flag of everyapp deploy, install, release and delete", () => {
    expectDocumented("deploy", "the flags of everyapp deploy, install, release and delete", flagsOf("deploy", "install", "release", "delete"));
  });
  it("setup.md documents every flag of everyapp setup, login, create and update", () => {
    expectDocumented("setup", "the flags of everyapp setup, login, create and update", flagsOf("setup", "login", "create", "update"));
    expectDocumented("setup", "the credentials", ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "EVERYAPP_GATEWAY_URL"]);
  });
  it("mcp.md documents the MCP settings, the SDK's tool API and every built-in tool", () => {
    expectDocumented("mcp", "the MCP settings and API", ["defineTools", "toolResult", "ToolError", "MCP_OAUTH_ENABLED", "MCP_DCR_ENABLED", "MCP_ALLOWED_ORIGINS", "MCP_AUDIT_RETENTION_DAYS", "epat_", "/mcp", "/oauth/register", "CLAUDE_CODE_INSTRUCTIONS_READ", "anthropic/alwaysLoad", "client_info", "client_name", "Mcp-Session-Id", "describeClient", "clientOfSession"]);
    expectDocumented("mcp", BUILTINS_WHAT, BUILTIN_TOOLS);
  });
  it("access.md documents every Cloudflare Access setting", () => {
    expectDocumented("access", "the Cloudflare Access settings", SETTABLE_GATEWAY_SETTINGS.filter((name) => name.startsWith("CLOUDFLARE_ACCESS_")));
    expectDocumented("access", "the password switch", ["EMAIL_PASSWORD_SIGN_IN"]);
  });
});

describe("backticked", () => {
  it("reads a double-backtick span as one span, so the names after it on the line still count", () => {
    const found = backticked(
      "instructions beginning ``Tools for <org>. Each tool is named `<app>_<tool>`; call everyapp_list_apps.`` then `Apps: <id>`, and `CLAUDE_CODE_INSTRUCTIONS_READ` near the end.",
    );
    expect(found.has("Tools for <org>. Each tool is named `<app>_<tool>`; call everyapp_list_apps.")).toBe(true);
    expect(found.has("Apps: <id>")).toBe(true);
    expect(found.has("CLAUDE_CODE_INSTRUCTIONS_READ")).toBe(true);
    expect(found.has(" then ")).toBe(false);
  });
});

describe("the everyapp skill", () => {
  it("points agents at the agent docs", () => {
    const skill = readPage("../../../packages/cli/skills/everyapp/SKILL");
    expect(skill).toContain("https://everyapp.com/llms.txt");
    expect(skill).toContain("/docs/agent/");
  });

  it("mcp.md names every built-in tool", () => {
    const missing = missingFrom(readPage("../../../packages/cli/skills/everyapp/mcp"), BUILTIN_TOOLS);
    expect(
      missing,
      `packages/cli/skills/everyapp/mcp.md doesn't name ${BUILTINS_WHAT}: ${missing.join(", ")}. Add each, in backticks, to the "Built-ins" line under "What the Gateway does with them".`,
    ).toEqual([]);
  });

  it("names no built-in tool the Gateway doesn't have, on the agent page or in the skill", () => {
    // The other direction: a built-in renamed or removed in the code leaves its old name behind.
    for (const [where, page] of [
      ["landing-page/content/agent/mcp.md", readPage("mcp")],
      ["packages/cli/skills/everyapp/mcp.md", readPage("../../../packages/cli/skills/everyapp/mcp")],
    ] as const) {
      const unknown = [...new Set(page.match(/everyapp_[A-Za-z0-9_-]+/g) ?? [])].filter((name) => !BUILTIN_TOOLS.includes(name));
      expect(unknown, `${where} names a built-in tool the Gateway connector doesn't list: ${unknown.join(", ")}. Rename or remove it there.`).toEqual([]);
    }
  });
});

describe("the threat model's invariant register", () => {
  it("names every built-in tool in toolbus.builtins-readonly-reserved", () => {
    const id = "toolbus.builtins-readonly-reserved";
    const register = readFileSync(
      fileURLToPath(new URL("../../../../docs/threat-model-invariants.md", import.meta.url)),
      "utf8",
    );
    const row = register.split("\n").find((line) => line.startsWith(`| ${id} |`));
    expect(row, `docs/threat-model-invariants.md has no row ${id}`).toBeDefined();
    // The invariant text (the second cell), as whole names: a built-in whose name is a prefix of another's, or one named only in the Pinned-by cell, doesn't count.
    const invariant = row!.split(" | ")[1] ?? "";
    const named = new Set(invariant.split(/[^A-Za-z0-9_-]+/));
    const missing = BUILTIN_TOOLS.filter((name) => !named.has(name));
    expect(
      missing,
      `the row ${id} in docs/threat-model-invariants.md doesn't name ${BUILTINS_WHAT}: ${missing.join(", ")}. Name each in the row's invariant text (the second column).`,
    ).toEqual([]);
  });
});
