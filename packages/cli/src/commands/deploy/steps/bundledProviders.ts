/**
 * `app.providers`: the provider specs an app bundles
 * (`.everyapp/providers/<id>.json`, or a release's `providers`;
 * lib/app/bundledProviders.ts), registered on the Gateway before the
 * manifest is checked against its registry, so an app that brings its own
 * provider deploys in one go. Every spec is parsed and checked first, and
 * nothing is written until all pass: a spec that doesn't parse, or one
 * whose id has a row with a different spec, stops the deploy before any
 * registration (a row is never silently overwritten: `everyapp provider
 * add <file> --replace` is the person's own move). A catalog id is left
 * alone with a warning (the catalog wins). The specs to register are
 * printed, hosts and secrets each, and registered after one explicit
 * confirmation: `--register-providers`, or the person's answer at a
 * terminal. `--yes` alone doesn't count: a spec decides where the
 * operator's key goes, so an agent's habitual `--yes` must not approve it.
 * Unattended without the flag, the deploy stops with CONFIRMATION_REQUIRED
 * whose rerun adds `--register-providers`.
 */
import {
  capabilitySettings,
  describeSpecProblems,
  parseProviderSpec,
  type RegistrableCapability,
} from "@every-app/sdk/internal";
import type { D1Database } from "@/lib/cf/d1";
import { canonicalJson, type BundledProviderSpec } from "@/lib/app/bundledProviders";
import { EveryAppError } from "@/lib/errors";
import { addProvider, gatewayRegistry } from "@/lib/gateway/providers";
import type { Deployer } from "@/lib/gateway/registry";
import type { InstallRecord } from "@/lib/gateway/install";
import { CLI, thisCommand } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { confirmAtTerminal, confirmOrCancel, type Confirm } from "@/lib/output/prompt";
import { listed } from "@/lib/output/text";

/** One spec as the step reports it. */
interface BundledProviderReport {
  id: string;
  name: string;
  file: string;
  hosts: string[];
  settings: string[];
  /** Registered by this run, there already with the same spec, or a catalog entry (the file is ignored). */
  outcome: "registered" | "unchanged" | "builtin";
}

interface Options {
  specs: readonly BundledProviderSpec[];
  appId: string;
  db: D1Database;
  install: Pick<InstallRecord, "gatewayHost" | "appBaseDomain">;
  deployer: Deployer;
  gatewayUrl: string;
  out: EventSink;
  interactive: boolean;
  /** `--register-providers`: the person's yes, given up front. */
  registerProviders?: boolean;
  confirm?: Confirm;
  now?: number;
}

/** The hosts a spec's key or client goes to, for the listing. */
function hostsOf(capability: RegistrableCapability): string[] {
  if (capability.mode === "oauth_client") return [...capability.api];
  if (capability.mode === "ai") return [`${capability.origin}${capability.basePath ?? ""}`];
  return [...capability.hosts, ...(capability.hostSetting ? [`<${capability.hostSetting}>`] : [])];
}

export async function registerBundledProviders(options: Options): Promise<BundledProviderReport[]> {
  const { specs, appId, db, install, out } = options;
  if (specs.length === 0) return [];
  const gatewayHost = options.gatewayUrl.replace(/^https:\/\//, "");
  const registry = await gatewayRegistry(db, install);
  const rows = new Map(registry.rows().map((row) => [row.id, row]));
  const reports: BundledProviderReport[] = [];
  const toRegister: Array<{ file: string; spec: unknown; id: string; capability: RegistrableCapability }> = [];
  for (const { file, spec } of specs) {
    const parsed = parseProviderSpec(typeof spec === "string" ? null : spec);
    if (!parsed.ok) {
      throw new EveryAppError(
        "PROVIDER_SPEC_INVALID",
        `${appId} bundles a provider spec this Gateway doesn't take: ${file}\n${typeof spec === "string" ? "it isn't JSON" : describeSpecProblems(parsed.problems)}. Nothing was registered.`,
        { fix: `fix the file (${CLI} provider add ${file} checks it), or delete it, then deploy again` },
      );
    }
    const { id, capability } = parsed;
    const report = {
      id,
      name: capability.label,
      file,
      hosts: hostsOf(capability),
      settings: [...capabilitySettings(capability)],
    };
    if (registry.sourceOf(id) === "catalog") {
      out.emit({
        type: "warning",
        code: "PROVIDER_BUNDLED_BUILTIN",
        message: `${file} describes ${id}, which is built in\nThe catalog entry is what the Gateway serves; the file is ignored. Delete it, or give the provider another id.`,
        data: { id, file },
      });
      reports.push({ ...report, outcome: "builtin" });
      continue;
    }
    const row = rows.get(id);
    if (row) {
      const storedSpec = await storedSpecOf(db, id);
      if (storedSpec !== null && canonicalJson(storedSpec) !== canonicalJson(spec)) {
        throw new EveryAppError(
          "PROVIDER_SPEC_DIFFERS",
          `${id} is registered on ${gatewayHost} with another spec than ${appId} bundles (${file})\nA deploy never replaces a registered provider's spec: replacing it changes where its key goes and unbinds the key. Nothing was registered.`,
          {
            fix: `compare them with ${CLI} provider show ${id}; to take the app's, run ${CLI} provider add ${file} --replace (then ${CLI} secret set ${report.settings.join(" ")}), or keep the Gateway's and delete the file`,
            data: { id, file, registeredBy: row.addedBy },
          },
        );
      }
      reports.push({ ...report, outcome: "unchanged" });
      continue;
    }
    toRegister.push({ file, spec, id, capability });
    reports.push({ ...report, outcome: "registered" });
  }
  if (toRegister.length === 0) {
    const unchanged = reports.filter((report) => report.outcome === "unchanged");
    if (unchanged.length > 0) {
      out.emit({
        type: "step",
        step: "app.providers",
        status: "ok",
        message: `${listed(unchanged.map((report) => report.id))} ${unchanged.length === 1 ? "is" : "are"} registered on ${gatewayHost} already, as ${appId} bundles ${unchanged.length === 1 ? "it" : "them"}.`,
        data: { providers: reports },
      });
    }
    return reports;
  }
  const lines = toRegister.map(
    ({ id, capability }) =>
      `${capability.label} (${id}): its key goes to ${listed(hostsOf(capability))}; settings ${listed([...capabilitySettings(capability)])}`,
  );
  out.emit({
    type: "step",
    step: "app.providers",
    status: "start",
    message: `${appId} bundles ${toRegister.length === 1 ? "a provider" : `${toRegister.length} providers`} to register on ${gatewayHost}:\n  ${lines.join("\n  ")}`,
    data: { providers: reports.filter((report) => report.outcome === "registered") },
  });
  if (!options.registerProviders) {
    if (!options.interactive) {
      throw new EveryAppError(
        "CONFIRMATION_REQUIRED",
        `${appId} bundles ${listed(toRegister.map(({ id }) => id))} to register on ${gatewayHost}\nRegistering a provider gives the Gateway a new host to send a key to, so it takes the person's yes (--register-providers; --yes doesn't). Nothing was registered.`,
        {
          rerun: thisCommand(["--register-providers"]),
          authorize: true,
          data: { providers: reports.filter((report) => report.outcome === "registered") },
        },
      );
    }
    await confirmOrCancel(options.confirm ?? confirmAtTerminal, `Register ${listed(toRegister.map(({ id }) => id))} on ${gatewayHost}?`, {
      context: lines,
      cancelled: "Nothing was registered or deployed.",
    });
  }
  for (const { spec } of toRegister) {
    await addProvider(db, { spec, deployer: options.deployer, install, now: options.now });
  }
  out.emit({
    type: "step",
    step: "app.providers",
    status: "ok",
    message: `Registered ${listed(toRegister.map(({ capability, id }) => `${capability.label} (${id})`))} on ${gatewayHost}.`,
    data: { providers: reports },
  });
  return reports;
}

/** The stored spec of row `id`, parsed; null when the row is gone. */
async function storedSpecOf(db: D1Database, id: string): Promise<unknown> {
  const [rows = []] = await db.run([{ sql: "SELECT spec FROM providers WHERE id = ?", params: [id] }]);
  const text = rows[0]?.["spec"];
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
