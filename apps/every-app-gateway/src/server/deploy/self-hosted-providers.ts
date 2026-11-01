/** Bundled providers use the SDK's registration rules and explicit consent. */
import {
  gatewayProviders,
  invalidateGatewayProviders,
  refusedGatewayHost,
} from "@/server/providers";
import { AppRepository } from "@/server/repositories/AppRepository";
import { ProviderRepository } from "@/server/repositories/ProviderRepository";
import { InstallationError } from "@every-app/perimeter/install";
import { validateManifestStrict } from "@every-app/perimeter/manifest";
import {
  capabilitySettings,
  checkProviderRow,
  describeSpecProblems,
  parseProviderSpec,
  providerRegistry,
  registrableHosts,
  secretNames,
  type ProviderRow,
} from "@every-app/sdk/internal";
import { env } from "cloudflare:workers";
import type { DeployBundle } from "./bundle";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

export async function planBundledProviders(bundle: DeployBundle) {
  const bytes = bundle.releaseFiles?.get("release.json");
  const release = bytes
    ? (JSON.parse(new TextDecoder().decode(bytes)) as { providers?: unknown[] })
    : {};
  const existing = await gatewayProviders();
  if (!release.providers?.length)
    return {
      reports: [],
      lookup: existing,
      register: async (_actor: string) => {},
    };
  const rows = await ProviderRepository.all();
  const planned: ProviderRow[] = [];
  const reports: Array<{
    id: string;
    name: string;
    hosts: string[];
    settings: string[];
  }> = [];
  const app = validateManifestStrict(bundle.manifest, {
    unknownCapabilities: "accept",
  });
  const appSecrets = new Set(
    secretNames(app).map((name) => name.toUpperCase()),
  );
  for (const row of await AppRepository.findAllManifests()) {
    try {
      if (row.manifest)
        for (const name of secretNames(JSON.parse(row.manifest)))
          appSecrets.add(name.toUpperCase());
    } catch {
      /* An invalid stored manifest grants nothing. */
    }
  }
  for (const spec of release.providers ?? []) {
    const parsed = parseProviderSpec(spec);
    if (!parsed.ok)
      throw new InstallationError(
        "PROVIDER_SPEC_INVALID",
        describeSpecProblems(parsed.problems),
      );
    const { id, capability } = parsed;
    if (existing.sourceOf(id) === "catalog") continue;
    const row = [...rows, ...planned].find((row) => row.id === id);
    if (row) {
      const stored: unknown =
        typeof row.spec === "string" ? JSON.parse(row.spec) : row.spec;
      if (canonical(stored) !== canonical(spec))
        throw new InstallationError(
          "PROVIDER_SPEC_DIFFERS",
          `${id} is already registered with a different specification. Installation never replaces a provider or changes where its keys go.`,
        );
      continue;
    }
    const registry = providerRegistry([...rows, ...planned]);
    const refusal = checkProviderRow(id, capability, {
      rowSettings: new Set(
        registry.rows().flatMap((row) => capabilitySettings(row.capability)),
      ),
      refuseHost: (host) => refusedGatewayHost(host, env),
    });
    if (refusal) throw new InstallationError(refusal.code, refusal.message);
    const settings = [...capabilitySettings(capability)];
    if (settings.some((name) => appSecrets.has(name.toUpperCase())))
      throw new InstallationError(
        "PROVIDER_SECRET_TAKEN",
        `${id} declares a setting already used as an app secret.`,
      );
    planned.push({
      id,
      spec: JSON.stringify(spec),
      addedBy: null,
      addedAt: null,
      boundTo: null,
    });
    reports.push({
      id,
      name: capability.label,
      hosts: registrableHosts(capability),
      settings,
    });
  }
  const added = providerRegistry(planned, {
    refuseHost: (host) => refusedGatewayHost(host, env),
  });
  const lookup = {
    get: (id: string) =>
      added.sourceOf(id) === "row" ? added.get(id) : existing.get(id),
    ids: () => [...new Set([...existing.ids(), ...added.ids()])],
  };
  return {
    reports,
    lookup,
    register: async (actor: string) => {
      for (const row of planned) {
        const inserted = await ProviderRepository.insert({
          id: row.id,
          spec: String(row.spec),
          addedBy: actor,
        });
        if (!inserted) {
          const now = await ProviderRepository.byId(row.id);
          if (
            !now ||
            canonical(JSON.parse(String(now.spec))) !==
              canonical(JSON.parse(String(row.spec)))
          )
            throw new InstallationError(
              "PROVIDER_SPEC_DIFFERS",
              `${row.id} changed during installation. Review the release again.`,
            );
        }
      }
      if (planned.length) invalidateGatewayProviders();
    },
  };
}
