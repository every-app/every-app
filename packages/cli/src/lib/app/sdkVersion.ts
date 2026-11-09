/**
 * The app's @every-app/sdk against this everyapp. They ship as one
 * version (`pnpm release`, scripts/release.mjs, publishes both at once). A
 * mismatch is only a warning: an app re-pins at the next release, and
 * until then it may well deploy with a newer CLI.
 *
 * A linked SDK (`pnpm link <checkout>/packages/sdk`, or `everyapp create`
 * from a checkout) says nothing: it is whatever that checkout holds, not a
 * release, and comparing its version would only be noise.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { EventSink } from "@/lib/output/events";
import { cliVersion, compareVersions } from "@/lib/version";

interface InstalledSdk {
  version: string;
  /** Resolved outside any node_modules: a link to a checkout, not an installed package. */
  linked: boolean;
}

/** The app's own @every-app/sdk, when it has one installed. */
export function appSdk(cwd: string): InstalledSdk | null {
  try {
    const require = createRequire(path.join(cwd, "package.json"));
    const file = require.resolve("@every-app/sdk/package.json");
    const version = (JSON.parse(fs.readFileSync(file, "utf8")) as { version?: string }).version;
    if (!version) return null;
    const linked = !fs.realpathSync(file).split(path.sep).includes("node_modules");
    return { version, linked };
  } catch {
    return null;
  }
}

/** The app's own @every-app/sdk version, when it has one installed. */
export function appSdkVersion(cwd: string): string | null {
  return appSdk(cwd)?.version ?? null;
}

/** SDK_VERSION_MISMATCH when the app's installed SDK isn't this everyapp's version. */
export function warnSdkVersion(cwd: string, out: EventSink, cli: string = cliVersion): void {
  const sdk = appSdk(cwd);
  if (sdk === null || sdk.linked || sdk.version === cli) return;
  const order = compareVersions(sdk.version, cli);
  if (order === 0) return;
  out.emit({
    type: "warning",
    code: "SDK_VERSION_MISMATCH",
    message: `This app's @every-app/sdk is ${sdk.version}, ${order < 0 ? "older" : "newer"} than this everyapp (${cli})\nThey are released together: pin both to one version (pnpm add @every-app/sdk@${cli} everyapp@${cli}).`,
    data: { sdkVersion: sdk.version, cliVersion: cli, pin: cli },
  });
}
