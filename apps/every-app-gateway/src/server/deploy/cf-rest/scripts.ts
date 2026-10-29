import { json, jsonPart, type CloudflareTransport } from "./client";
import { workerUploadForm, type DispatchScript } from "./dispatch";
import type {
  WorkerMetadata,
  WorkerModule,
  WorkerSettings,
  WorkerSettingsResult,
} from "./types";

interface WorkerDomain {
  hostname: string;
  service: string;
  zone_id: string;
}

/** Account Workers used by the self-hosted Gateway's app installer. */
export function scripts(transport: CloudflareTransport) {
  const path = (script: string, ...parts: string[]) =>
    transport.accountPath("workers", "scripts", script, ...parts);
  return {
    list: () =>
      transport.request<DispatchScript[]>(
        transport.accountPath("workers", "scripts"),
        {},
        { context: "List Worker scripts" },
      ),
    settings: (script: string) =>
      transport.request<WorkerSettingsResult>(
        path(script, "settings"),
        {},
        { context: `Read settings of ${script}`, envelopeOptional: true },
      ),
    patchSettings: (script: string, settings: WorkerSettings) => {
      const form = new FormData();
      form.set("settings", jsonPart(settings));
      return transport.request<WorkerSettingsResult>(
        path(script, "settings"),
        { method: "PATCH", body: form },
        { context: `Patch settings of ${script}`, envelopeOptional: true },
      );
    },
    upload: (
      script: string,
      upload: { metadata: WorkerMetadata; modules: WorkerModule[] },
    ) =>
      transport.request<DispatchScript>(
        path(script),
        { method: "PUT", body: workerUploadForm(script, upload) },
        { context: `Upload Worker ${script}`, envelopeOptional: true },
      ),
    deployments: (script: string) =>
      transport.request<{
        deployments: Array<{
          created_on: string;
          versions: Array<{ version_id: string; percentage: number }>;
        }>;
      }>(
        path(script, "deployments"),
        {},
        { context: `Read deployments of ${script}`, envelopeOptional: true },
      ),
    disableSubdomain: (script: string) =>
      transport.request(
        path(script, "subdomain"),
        json("POST", { enabled: false, previews_enabled: false }),
        {
          context: `Disable public previews of ${script}`,
          envelopeOptional: true,
        },
      ),
    delete: (script: string) =>
      transport.request<null>(
        `${path(script)}?force=true`,
        { method: "DELETE" },
        { context: `Delete Worker ${script}`, envelopeOptional: true },
      ),
    domains: (hostname: string) =>
      transport.request<WorkerDomain[]>(
        `${transport.accountPath("workers", "domains")}?hostname=${encodeURIComponent(hostname)}`,
        {},
        { context: `Read domain ${hostname}` },
      ),
    attachDomain: (domain: WorkerDomain) =>
      transport.request(
        transport.accountPath("workers", "domains"),
        json("PUT", domain),
        {
          context: `Publish domain ${domain.hostname}`,
          envelopeOptional: true,
        },
      ),
    dnsRecords: (zoneId: string, hostname: string) =>
      transport.request<Array<{ type: string }>>(
        `/zones/${encodeURIComponent(zoneId)}/dns_records?name=${encodeURIComponent(hostname)}&per_page=100`,
        {},
        { context: `Check DNS for ${hostname}` },
      ),
  };
}
