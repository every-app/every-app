/**
 * The MCP conformance suite against a local ToolBus (see ./server.ts), for
 * both protocol eras, with the expected failures in
 * ../conformance-baseline.yml. Downloads the suite with npx, so it needs
 * the network and stays out of `pnpm test`; run `pnpm test:conformance`.
 *
 * CONFORMANCE_PORT picks the local port (default: any free one).
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startConformanceServer } from "./server";

const SUITE = "@modelcontextprotocol/conformance@0.2.0-alpha.12";
const BASELINE = fileURLToPath(
  new URL("../conformance-baseline.yml", import.meta.url),
);

// The design's curated set: the protocol scenarios a catalog-driven,
// tools-only, stateless server can answer. The tool-call scenarios need the
// suite's "everything server" tools by name, so they aren't here.
const SCENARIOS: [scenario: string, specVersion: string][] = [
  ["server-stateless", "2026-07-28"],
  ["http-header-validation", "2026-07-28"],
  ["caching", "2026-07-28"],
  ["tools-list", "2026-07-28"],
  ["dns-rebinding-protection", "2026-07-28"],
  ["server-initialize", "2025-11-25"],
  ["ping", "2025-11-25"],
  ["tools-list", "2025-11-25"],
  ["dns-rebinding-protection", "2025-11-25"],
  ["server-initialize", "2025-06-18"],
  ["ping", "2025-06-18"],
  ["tools-list", "2025-06-18"],
];

/** Run the suite's CLI without blocking this process, which serves it. */
function runSuite(args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["-y", SUITE, ...args], {
      env: { ...process.env, NO_COLOR: "1" },
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

let server: Awaited<ReturnType<typeof startConformanceServer>>;
let resultsDir: string;

beforeAll(async () => {
  server = await startConformanceServer(
    Number(process.env["CONFORMANCE_PORT"] ?? 0),
  );
  resultsDir = await mkdtemp(join(tmpdir(), "toolbus-conformance-"));
});

afterAll(async () => {
  await server?.close();
  if (resultsDir) await rm(resultsDir, { recursive: true, force: true });
});

describe("MCP conformance", () => {
  for (const [scenario, specVersion] of SCENARIOS) {
    it(`${scenario} at ${specVersion}`, async () => {
      const { code, output } = await runSuite([
        "server",
        "--url",
        server.url,
        "--scenario",
        scenario,
        "--spec-version",
        specVersion,
        "--expected-failures",
        BASELINE,
        "--output-dir",
        resultsDir,
      ]);
      console.log(
        output.match(/Passed: .*/)?.[0] ?? "(no summary)",
        `${scenario} @ ${specVersion}`,
      );
      expect(code, output).toBe(0);
    });
  }
});
