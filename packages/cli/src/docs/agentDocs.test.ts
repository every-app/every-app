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
  PROVIDER_APP_IDS,
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
  EVENT_HEADERS,
  EVENT_TYPES,
  EVENTS_ALLOW_PRIVATE_TARGETS_SETTING,
  SIGN_IN_GATEWAY_SETTINGS,
  SIGN_IN_PROVIDER_IDS,
} from "@every-app/sdk/internal";
import { builtinToolKind, listBuiltinTools } from "@every-app/toolbus";
import { commandPaths } from "@/app";
import { NextCode } from "@/commands/status/next";
import { cliReference, commandDocs } from "./cliReference";
import { codeInventory } from "./codes";
import { manifestFields } from "./manifestFields";
import { catalogSettings, providersCatalog, setupProvidersPage, withBlock } from "./providersCatalog";
import { BUILD_SKILL, buildPage, patternsPage } from "./skillPages";
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

/** The slugs of the hand-written and generated agent pages (the mirrored repo/ pages are built later). */
const slugs = () =>
  readdirSync(fileURLToPath(AGENT_DOCS_DIR))
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.replace(/\.md$/, ""));

describe("the agent docs", () => {
  it("has every page the index and the sidebar name", () => {
    for (const slug of [
      "index",
      "setup",
      "cli",
      "json",
      "errors",
      "troubleshooting",
      "status",
      "manifest",
      "identity",
      "secrets",
      "dev",
      "email",
      "events",
      "mcp",
      "deploy",
      "providers",
      "access",
      "signin",
      "workspace",
      "gateway",
      "build",
      "patterns",
    ]) {
      expect(slugs(), `${slug}.md`).toContain(slug);
    }
  });

  it("is the sidebar: every page is in meta.json, and meta.json names only pages that exist", () => {
    // landing-page/content/agent/meta.json lists the pages by hand (no `...`
    // entry), so a page left out of it is missing from the sidebar, and a slug
    // without a page is a dead entry. The separators (`---Drive it---`), the
    // link back to the user docs (`[Back …](/docs)`) and the mirrored `repo`
    // folder are not pages here.
    const meta = JSON.parse(readFileSync(fileURLToPath(new URL("meta.json", AGENT_DOCS_DIR)), "utf8")) as {
      pages: string[];
    };
    const listed = meta.pages.filter(
      (entry) => !/^---.*---$/.test(entry) && !entry.startsWith("[") && entry !== "repo",
    );
    expect(listed, "meta.json reads as a page list").toEqual(
      expect.arrayContaining(["index", "setup", "cli", "gateway", "build", "patterns"]),
    );
    const pages = slugs();
    expect(listed.filter((slug) => !pages.includes(slug)), "slugs in meta.json without a page").toEqual([]);
    expect(pages.filter((slug) => !listed.includes(slug)), "pages missing from meta.json (the sidebar)").toEqual([]);
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

/**
 * A generated block of a hand-written page (between its `<!-- <name>:begin` and
 * `<!-- <name>:end -->` markers) against what the catalog generates now:
 * rewritten by `docs:update`, compared otherwise.
 */
function expectBlock(slug: string, name: string, block: string): void {
  const page = readPage(slug);
  const updated = withBlock(page, name, block);
  expect(updated, `${slug}.md has no ${name} block (its begin and end markers inside a prettier-ignore range)`).not.toBeNull();
  if (UPDATE_DOCS) {
    if (updated !== page) writePage(slug, updated!);
    return;
  }
  expect(page, `${slug}.md's ${name} block is out of date with the provider catalog: run \`pnpm -C packages/cli docs:update\` and commit the result`).toBe(updated);
}

describe("providers.md", () => {
  it("has the catalog the provider catalog generates", () => {
    expectBlock("providers", "providers-catalog", providersCatalog());
  });

  it("names the registry's commands, flags and codes", () => {
    expectDocumented("providers", "the flags of everyapp provider", flagsOf("provider"));
    expectDocumented("providers", "the provider registry's codes", [
      "PROVIDER_SPEC_INVALID",
      "PROVIDER_EXISTS",
      "PROVIDER_BUILTIN",
      "PROVIDER_NOT_FOUND",
      "PROVIDER_IN_USE",
      "PROVIDER_SECRET_TAKEN",
      "PROVIDER_HOST_REFUSED",
      "PROVIDER_PRESET_UNKNOWN",
      "PROVIDER_CLIENT_INCOMPLETE",
      "PROVIDER_CONNECTION_WHICH",
      "PROVIDER_CONNECTION_NOT_FOUND",
      "integration_not_connected",
      "CAPABILITY_UNKNOWN",
      "CAPABILITY_NOT_IN_CATALOG",
      "integration_read_only",
      "integration_upstream_redirected",
      "integration_not_available_hosted",
      "integration_not_configured",
      "integration_scopes_undeclared",
      "integration_scope_not_allowed",
      "provider.row_invalid",
      "EVERYAPP_DEV_PROVIDERS",
    ]);
  });
});

describe("build.md and patterns.md", () => {
  it.each([
    ["build", BUILD_SKILL.skill, buildPage],
    ["patterns", BUILD_SKILL.patterns, patternsPage],
  ] as const)("%s.md is what %s generates", (slug, source, generate) => {
    const generated = generate();
    if (UPDATE_DOCS) {
      writePage(slug, generated);
      return;
    }
    expect(
      readPage(slug),
      `${slug}.md is out of date with ${source}: run \`pnpm -C packages/cli docs:update\` and commit the result`,
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
  it("documents every next-step code status reports", () => {
    expectDocumented(
      "json",
      "the next-step codes of status (NextCode in packages/cli/src/commands/status/next.ts)",
      Object.values(NextCode),
    );
  });
});

describe("manifest.md", () => {
  const fields = manifestFields();
  it("reads the schema (an empty walk would document nothing and pass)", () => {
    expect(fields.paths).toEqual(expect.arrayContaining(["id", "capabilities.<id>.access", "migrations.engine", "secrets[].anyOf"]));
    expect(fields.values).toEqual(expect.arrayContaining(["drizzle", "read", "write"]));
    expect(fields.paths.length).toBeGreaterThanOrEqual(70);
    expect(fields.values.length).toBeGreaterThanOrEqual(15);
  });
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
  it("documents every secret and configure flag", () => {
    expectDocumented("secrets", "the flags of everyapp secret and everyapp configure", flagsOf("secret", "configure"));
  });
  it("has the AI and API-key settings the provider catalog generates", () => {
    expectBlock("secrets", "ai-provider-settings", catalogSettings("ai"));
    expectBlock("secrets", "api-key-provider-settings", catalogSettings("api_key"));
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
  it("events.md documents every event type, flag, header, code and the app-emit refusals", () => {
    expectDocumented("events", "the event types (EVENT_TYPES in packages/sdk/src/internal/events.ts)", EVENT_TYPES.map((info) => info.type));
    // Section 8's flags must be in the walk, so a missing or renamed `events` group fails here rather than documenting nothing.
    expect(flagsOf("events")).toEqual(expect.arrayContaining(["--events", "--email", "--secret-from-env", "--no-wait", "--dead"]));
    expectDocumented("events", "the flags of everyapp events", flagsOf("events"));
    expectDocumented("events", "the delivery headers (EVENT_HEADERS)", Object.values(EVENT_HEADERS));
    expectDocumented("events", "the setting, the SDK call and the app event pattern", [EVENTS_ALLOW_PRIVATE_TARGETS_SETTING, "emit", "app.<id>.<name>"]);
    expectDocumented("events", "the error codes of everyapp events", [
      "EVENT_TARGET_REFUSED",
      "EVENT_SUBSCRIPTIONS_LIMIT",
      "EVENT_SUBSCRIPTION_NOT_FOUND",
      "EVENT_DELIVERY_NOT_FOUND",
      "EVENT_TYPE_UNKNOWN",
      "EVENT_SECRET_INVALID",
      "EVENT_SINK_CONFLICT",
      "EVENT_TEST_TIMEOUT",
    ]);
    expectDocumented("events", "the refusals of an app's emit", [
      "event_name_invalid",
      "event_data_invalid",
      "event_data_too_large",
      "event_data_refused",
      "event_rate_limited",
    ]);
  });
  it("the user page /docs/events lists every event type", () => {
    // The person's page carries the catalogue too, so a new type fails here until it is listed there as well.
    const userPage = readFileSync(fileURLToPath(new URL("../docs/events.mdx", AGENT_DOCS_DIR)), "utf8");
    const missing = missingFrom(userPage, EVENT_TYPES.map((info) => info.type));
    expect(missing, `landing-page/content/docs/events.mdx doesn't list these event types in its table: ${missing.join(", ")}`).toEqual([]);
  });

  it("workspace.md documents every workspace command, its flags and every workspace tool", () => {
    const commands = commandPaths().filter(
      (path) => path.startsWith("workspace ") && !commandPaths().some((other) => other.startsWith(`${path} `)),
    );
    // A command is documented by a span that is the path or starts with it (`workspace rename <name>`).
    const spans = [...backticked(readPage("workspace"))];
    const undocumented = commands.filter((path) => !spans.some((span) => span === path || span.startsWith(`${path} `)));
    expect(undocumented, `workspace.md doesn't document the workspace commands: ${undocumented.join(", ")}. ${HOW}`).toEqual([]);
    // A flag counts when a usage line carries it (`workspace invite <email> [--role admin]`).
    const flags = flagsOf("workspace").filter((flag) => !["--json", "--verbose", "--gateway", "--account-id", "--yes"].includes(flag));
    const missingFlags = flags.filter((flag) => !spans.some((span) => new RegExp(`(^|[\\s\\[|])${flag}(?=$|[\\s\\]=|<])`).test(span)));
    expect(missingFlags, `workspace.md doesn't document the flags of everyapp workspace: ${missingFlags.join(", ")}. ${HOW}`).toEqual([]);
    expectDocumented(
      "workspace",
      "the workspace tools and the member tools (listBuiltinTools in packages/toolbus)",
      BUILTIN_TOOLS.filter((name) => name.startsWith("everyapp_workspace_") || /^everyapp_(my|revoke)_/.test(name)),
    );
  });
  it("access.md documents every Cloudflare Access setting", () => {
    expectDocumented("access", "the Cloudflare Access settings", SETTABLE_GATEWAY_SETTINGS.filter((name) => name.startsWith("CLOUDFLARE_ACCESS_")));
    expectDocumented("access", "the password switch", ["EMAIL_PASSWORD_SIGN_IN"]);
  });
  it("signin.md documents every sign-in provider, setting and flag", () => {
    expectDocumented("signin", "the sign-in provider ids (SIGN_IN_PROVIDER_IDS in packages/sdk/src/internal/signInProviders.ts)", SIGN_IN_PROVIDER_IDS);
    expectDocumented("signin", "the sign-in providers' settings (SIGN_IN_GATEWAY_SETTINGS)", SIGN_IN_GATEWAY_SETTINGS);
    expectDocumented("signin", "the password switch", ["EMAIL_PASSWORD_SIGN_IN"]);
    expect(flagsOf("signin"), "everyapp signin has no flags: is the command group on this branch?").toEqual(
      expect.arrayContaining(["--client-id", "--client-secret-from-env"]),
    );
    expectDocumented("signin", "the flags of everyapp signin", flagsOf("signin"));
    expectDocumented("signin", "the codes of everyapp signin and the sign-in page", [
      "SIGNIN_UNKNOWN_PROVIDER",
      "SIGNIN_VALUE_REQUIRED",
      "SIGNIN_FLAG_NOT_APPLICABLE",
      "SIGNIN_ISSUER_INVALID",
      "SIGNIN_TENANT_INVALID",
      "SIGNIN_NOT_SET_UP",
      "SIGNIN_NOT_INVITED",
      "SIGNIN_EMAIL_NOT_VERIFIED",
      "SIGNIN_ACCOUNT_DEACTIVATED",
      "SIGNIN_PROVIDER_UNAVAILABLE",
    ]);
  });
});

describe("gateway.md", () => {
  const page = () => readPage("gateway");

  it("names every CLI route, as `everyapp <route>` or the route itself", () => {
    const found = [...backticked(page())];
    const named = (route: string) =>
      found.some((span) => span === route || new RegExp(`^(?:pnpm )?everyapp ${route}(?:\\s|$)`).test(span));
    const missing = commandPaths().filter((route) => !named(route));
    expect(
      missing,
      `gateway.md doesn't name these CLI routes (commandPaths in packages/cli/src/app.ts), in backticks as \`pnpm everyapp <route>\` or the route alone: ${missing.join(", ")}. ${HOW}`,
    ).toEqual([]);
  });

  it("names every built-in tool and every provider app", () => {
    expectDocumented("gateway", BUILTINS_WHAT, BUILTIN_TOOLS);
    expectDocumented("gateway", "the provider app ids (PROVIDER_APP_IDS in packages/sdk/src/internal/providerApps.ts)", PROVIDER_APP_IDS);
  });

  it("names the listing modes and the header that picks one", () => {
    expectDocumented("gateway", "the listing modes of the connector", ["X-EveryApp-Tools", "compact", "full"]);
  });

  it("names both manifest access values, since it says who can open a new app", () => {
    expectDocumented(
      "gateway",
      "the manifest's access values (AppAccessSchema in packages/perimeter/src/manifest/manifest.ts)",
      ["everyone", "admins"],
    );
  });

  it("names every Admin tab as the Gateway labels it, with its route", () => {
    // The tabs of Manage workspace, from the route that draws them: a renamed
    // or added tab fails here until the page says it.
    const admin = readFileSync(
      fileURLToPath(new URL("../../../../apps/every-app-gateway/src/routes/_app/admin.tsx", import.meta.url)),
      "utf8",
    );
    const tabs = [...admin.matchAll(/label: "([^"]+)",\s*to: "(\/admin\/[a-z-]+)"/g)].map((match) => ({
      label: match[1]!,
      to: match[2]!,
    }));
    expect(tabs.map((tab) => tab.label), "the tabs read from admin.tsx").toEqual(
      expect.arrayContaining(["Users", "Apps", "Groups", "Usage", "Activity", "Tokens"]),
    );
    const text = page();
    const missingLabels = tabs.filter((tab) => !text.includes(`**${tab.label}**`)).map((tab) => tab.label);
    expect(missingLabels, "Admin tabs gateway.md doesn't name in bold, as the Gateway labels them").toEqual([]);
    expectDocumented("gateway", "the Admin tabs' routes", tabs.map((tab) => tab.to));
  });

  it("names every MCP server address the setup skill's section names", () => {
    // The one source for which servers to recommend beside Every App is the
    // setup skill's section "Optional: MCP servers worth having beside Every
    // App" (packages/cli/skills/everyapp/setup/gateway.md); this page says
    // the same, so an address that changes there fails here until it is
    // changed here too.
    const skill = readPage("../../../packages/cli/skills/everyapp/setup/gateway");
    const section = skill.split(/^## /m).find((part) => part.startsWith("Optional: MCP servers")) ?? "";
    expect(section, "the setup skill has its MCP servers section").not.toBe("");
    const addresses = [...new Set([...section.matchAll(/`(https:\/\/[^`\s]+\/mcp)`/g)].map((match) => match[1]!))];
    expect(addresses, "the section names Cloudflare's server in backticks").toContain("https://mcp.cloudflare.com/mcp");
    expectDocumented("gateway", "the MCP server addresses the setup skill names", addresses);
  });
});

describe("the Gateway's Build-your-own prompt", () => {
  // apps/every-app-gateway/src/client/lib/buildPrompt.ts names the agent
  // pages the prompt sends an agent to; a renamed slug fails here.
  const file = new URL("../../../../apps/every-app-gateway/src/client/lib/buildPrompt.ts", import.meta.url);

  it("points at agent pages that exist", () => {
    const source = readFileSync(file, "utf8");
    const slugs = [...source.matchAll(/https:\/\/everyapp\.com\/docs\/agent\/([a-z0-9-]+)\.md/g)].map((match) => match[1]!);
    expect(slugs, "the prompt names at least the build and patterns pages").toEqual(
      expect.arrayContaining(["build", "patterns"]),
    );
    const missing = slugs.filter((slug) => !existsSync(fileURLToPath(new URL(`${slug}.md`, AGENT_DOCS_DIR))));
    expect(missing, "pages buildPrompt.ts names that landing-page/content/agent doesn't have").toEqual([]);
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

  it("setup/providers.md is what the provider catalog generates", () => {
    const slug = "../../../packages/cli/skills/everyapp/setup/providers";
    const generated = setupProvidersPage();
    if (UPDATE_DOCS) {
      writePage(slug, generated);
      return;
    }
    expect(
      readPage(slug),
      "packages/cli/skills/everyapp/setup/providers.md is out of date with the provider catalog: run `pnpm -C packages/cli docs:update` and commit the result",
    ).toBe(generated);
  });

  it("lists every agent page in its Docs paragraph", () => {
    // The "Pages: setup (…), cli (…), …" sentence: each slug as an item,
    // followed by its parenthesis or a comma, so a new page is named there.
    const skill = readPage("../../../packages/cli/skills/everyapp/SKILL");
    const sentence = skill.match(/Pages: [\s\S]*?\.\s+[A-Z]/)?.[0] ?? "";
    expect(sentence, "the skill's Docs paragraph has a Pages: sentence").not.toBe("");
    const pages = slugs().filter((slug) => slug !== "index");
    const missing = pages.filter((slug) => !new RegExp(`(^|[\\s,])${slug}(?=\\s*\\(|,)`).test(sentence));
    expect(
      missing,
      `packages/cli/skills/everyapp/SKILL.md's Docs paragraph doesn't list these agent pages: ${missing.join(", ")}. Add each to its "Pages:" sentence, as "<slug> (what it answers)".`,
    ).toEqual([]);
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
  const register = readFileSync(
    fileURLToPath(new URL("../../../../docs/threat-model-invariants.md", import.meta.url)),
    "utf8",
  );
  const rowOf = (id: string) => register.split("\n").find((line) => line.startsWith(`| ${id} |`));
  // The invariant text (the second cell), as whole names: a built-in whose name is a prefix of another's, or one named only in the Pinned-by cell, doesn't count.
  const namedIn = (row: string) => new Set((row.split(" | ")[1] ?? "").split(/[^A-Za-z0-9_-]+/));

  it("names the core built-ins in toolbus.builtins-readonly-reserved and the workspace tools in toolbus.workspace-tools-role-gated", () => {
    // Split by the tool's kind: the view-answered built-ins and the wrappers
    // are one row's subject, the host-run workspace tools another's.
    for (const [id, kinds] of [
      ["toolbus.builtins-readonly-reserved", ["answer", "wrapper"]],
      ["toolbus.workspace-tools-role-gated", ["host"]],
    ] as const) {
      const row = rowOf(id);
      expect(row, `docs/threat-model-invariants.md has no row ${id}`).toBeDefined();
      const named = namedIn(row!);
      const expected = BUILTIN_TOOLS.filter((name) => (kinds as readonly string[]).includes(builtinToolKind(name) ?? ""));
      expect(expected.length, `no built-in of kind ${kinds.join("/")}`).toBeGreaterThan(0);
      const missing = expected.filter((name) => !named.has(name));
      expect(
        missing,
        `the row ${id} in docs/threat-model-invariants.md doesn't name ${BUILTINS_WHAT}: ${missing.join(", ")}. Name each in the row's invariant text (the second column).`,
      ).toEqual([]);
    }
  });

  it("names the provider tools in providers.tools-self-host-admin", () => {
    const row = rowOf("providers.tools-self-host-admin");
    expect(row, "docs/threat-model-invariants.md has no row providers.tools-self-host-admin").toBeDefined();
    const named = namedIn(row!);
    const expected = BUILTIN_TOOLS.filter((name) => name.startsWith("everyapp_provider_"));
    expect(expected.length, "no provider tool among the built-ins").toBeGreaterThan(0);
    const missing = expected.filter((name) => !named.has(name));
    expect(missing, `the row providers.tools-self-host-admin in docs/threat-model-invariants.md doesn't name: ${missing.join(", ")}`).toEqual([]);
  });

  it("has the row that says no built-in returns a credential", () => {
    expect(rowOf("toolbus.workspace-tools-no-credentials"), "docs/threat-model-invariants.md has no row toolbus.workspace-tools-no-credentials").toBeDefined();
  });
});
