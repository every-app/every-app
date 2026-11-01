/**
 * The harness registry: one factory per adapter (each call is a fresh
 * adapter, because Codex's normalizer keeps the thread id between lines)
 * and the names `--harness` accepts.
 */
import type { HarnessAdapter, HarnessName } from "../types";
import { createClaudeAdapter } from "./claude";
import { createCodexAdapter } from "./codex";
import { createCursorAdapter } from "./cursor";
import { createHermesAdapter } from "./hermes";
import { createOpencodeAdapter } from "./opencode";
import { createScriptAdapter } from "./script";

export const HARNESS_NAMES: readonly HarnessName[] = [
  "script",
  "claude",
  "codex",
  "opencode",
  "cursor",
  "hermes",
];

const FACTORIES: Record<HarnessName, () => HarnessAdapter> = {
  script: createScriptAdapter,
  claude: createClaudeAdapter,
  codex: createCodexAdapter,
  opencode: createOpencodeAdapter,
  cursor: createCursorAdapter,
  hermes: createHermesAdapter,
};

export function isHarnessName(value: string): value is HarnessName {
  return (HARNESS_NAMES as readonly string[]).includes(value);
}

/** A fresh adapter for one run (or one resumed process). */
export function createHarness(name: HarnessName): HarnessAdapter {
  return FACTORIES[name]();
}

/** The binaries `loop doctor` checks inside the image, per harness. */
export const HARNESS_BINARIES: Record<HarnessName, string> = {
  script: "bash",
  claude: "claude",
  codex: "codex",
  opencode: "opencode",
  cursor: "agent",
  hermes: "hermes",
};
