/**
 * Every code the CLI can put in an event, read from the source, so the
 * errors page of the agent docs can be checked against them: the literal
 * codes commands raise, the ones the reporter gives, cf's kinds, the
 * argument parser's, the warnings, what `status` reports as fixes, the
 * actions a person must take, and what a hosted Gateway's deploy API
 * answers (which `deploy --gateway` passes through).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ArgumentErrorCode } from "@/argumentErrors";
import { ProblemCode } from "@/commands/status/problems";
import { ReportCode } from "@/lib/errors";
import { REQUIRED_ACTIONS } from "@/lib/output/events";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const GATEWAY_DEPLOY = fileURLToPath(
  new URL("../../../../apps/every-app-gateway/src/server/deploy", import.meta.url),
);

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== "test" && entry !== "__fixtures__" && entry !== "docs") walk(full);
      } else if (full.endsWith(".ts") && !full.endsWith(".test.ts")) {
        files.push(full);
      }
    }
  };
  walk(root);
  return files.sort();
}

function collect(
  files: string[],
  pattern: RegExp,
  into: Map<string, Set<string>>,
  root: string,
): void {
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(pattern)) {
      const code = match[1]!;
      const sites = into.get(code) ?? new Set<string>();
      sites.add(path.relative(root, file).split(path.sep).join("/"));
      into.set(code, sites);
    }
  }
}

interface CodeInventory {
  /** `new EveryAppError("CODE"`, and the literal fallbacks (`?? "CODE"`). */
  errors: Map<string, Set<string>>;
  /** The `warning` events' codes. */
  warnings: Map<string, Set<string>>;
  /** What lib/output/report.ts gives: ReportCode, cf's kinds, the manifest's. */
  reporter: string[];
  argument: string[];
  status: string[];
  actions: string[];
  /** The hosted deploy API's codes, by file under the gateway's server/deploy. */
  hostedApi: Map<string, Set<string>>;
}

function cfKinds(): string[] {
  const text = readFileSync(path.join(SRC, "lib", "cf", "errors.ts"), "utf8");
  const union = text.match(/type CfErrorKind =([\s\S]*?);/)?.[1] ?? "";
  return [...union.matchAll(/"([a-z_0-9]+)"/g)].map((match) => match[1]!);
}

export function codeInventory(): CodeInventory {
  const files = sourceFiles(SRC);
  const errors = new Map<string, Set<string>>();
  collect(files, /new EveryAppError\(\s*"([A-Z][A-Z_0-9]+)"/g, errors, SRC);
  collect(files, /\?\? "([A-Z]+_[A-Z_0-9]+)"/g, errors, SRC);
  // A code chosen before the raise: `const code = kind === "x" ? "A_B" : "C_D";`.
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const statement of text.matchAll(/\bcode\s*=\s*([^;]+);/g)) {
      for (const literal of statement[1]!.matchAll(/"([A-Z]+_[A-Z_0-9]+)"/g)) {
        const sites = errors.get(literal[1]!) ?? new Set<string>();
        sites.add(path.relative(SRC, file).split(path.sep).join("/"));
        errors.set(literal[1]!, sites);
      }
    }
  }
  const warnings = new Map<string, Set<string>>();
  collect(files, /type: "warning",\s*code: "([A-Z][A-Z_0-9]+)"/g, warnings, SRC);
  const hostedApi = new Map<string, Set<string>>();
  const gateway = sourceFiles(GATEWAY_DEPLOY);
  collect(
    gateway,
    /(?:new DeployError|unauthorized)\(\s*"([A-Z][A-Z_0-9]+)"/g,
    hostedApi,
    GATEWAY_DEPLOY,
  );
  collect(gateway, /(?:code|error): "([A-Z][A-Z_0-9]+)"/g, hostedApi, GATEWAY_DEPLOY);
  return {
    errors,
    warnings,
    reporter: [
      ...Object.values(ReportCode),
      "INVALID_MANIFEST",
      "CF_TIMEOUT",
      "CF_OUTPUT",
      ...cfKinds().map((kind) => `CF_${kind.toUpperCase()}`),
    ],
    argument: Object.values(ArgumentErrorCode),
    status: Object.values(ProblemCode),
    actions: [...REQUIRED_ACTIONS],
    hostedApi,
  };
}
