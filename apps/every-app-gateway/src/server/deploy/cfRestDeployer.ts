/**
 * The DeployerPort over Cloudflare's REST API (`./cf-rest`): one
 * account and the Gateway's CF_DEPLOY_TOKEN. Hosted apps stay in their
 * dispatch namespace. Self-hosted installs use private account
 * Workers and the same service-binding/hostname topology as the CLI.
 */
import {
  createCloudflareRest,
  isCloudflareNotFound,
  type CloudflareRest,
} from "@/server/deploy/cf-rest";
import { DeployError } from "./errors";
import type { DeployerPort } from "./port";
import { env } from "cloudflare:workers";
import { gatewayNamesOf } from "@/server/gateway-name";
import type { AppRow } from "@every-app/perimeter/registry";
import {
  recordBrowserGatewayDeployment,
  withInstallLease,
} from "./browser-install";
import { claimBrowserWorker, recordBrowserWorkerVersion } from "./ledger";

interface DeployerEnv {
  CF_DEPLOY_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  DISPATCH_NAMESPACE?: string;
}

export class CfRestDeployer implements DeployerPort {
  constructor(
    private readonly cf: CloudflareRest,
    private readonly namespace: string | null,
    private readonly lease?: () => Promise<void>,
    private readonly app?: AppRow,
  ) {}

  /** `fetch`: tests pass the fake Cloudflare's API. */
  static fromEnv(env: DeployerEnv, fetch?: typeof globalThis.fetch) {
    const apiToken = env.CF_DEPLOY_TOKEN?.trim();
    const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
    const namespace = env.DISPATCH_NAMESPACE?.trim();
    if (!apiToken || !accountId || !namespace) {
      throw new DeployError(
        "DEPLOYER_NOT_CONFIGURED",
        503,
        "This gateway's deployer isn't configured (CF_DEPLOY_TOKEN, CLOUDFLARE_ACCOUNT_ID and DISPATCH_NAMESPACE).",
      );
    }
    return new CfRestDeployer(
      createCloudflareRest({
        apiToken,
        accountId,
        ...(fetch ? { fetch } : {}),
      }),
      namespace,
    );
  }

  static fromSelfHostedEnv(env: DeployerEnv) {
    const apiToken = env.CF_DEPLOY_TOKEN?.trim();
    const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
    if (!apiToken || !accountId)
      throw new DeployError(
        "DEPLOYER_NOT_CONFIGURED",
        503,
        "Set CF_DEPLOY_TOKEN and CLOUDFLARE_ACCOUNT_ID on the Gateway.",
      );
    return new CfRestDeployer(
      createCloudflareRest({
        apiToken,
        accountId,
        fetch: (input, init) =>
          fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }),
      }),
      null,
    );
  }

  usingLease(lease: () => Promise<void>, app: AppRow) {
    return new CfRestDeployer(this.cf, this.namespace, lease, app);
  }

  async createDatabase(name: string): Promise<string> {
    await this.lease?.();
    return (await this.cf.d1.create(name)).uuid;
  }

  async findDatabase(name: string): Promise<string | null> {
    return (await this.cf.d1.findByName(name))?.uuid ?? null;
  }

  async batch(
    databaseId: string,
    statements: Parameters<DeployerPort["batch"]>[1],
  ) {
    await this.lease?.();
    const results = await this.cf.d1.batch(databaseId, [...statements]);
    return results.map((result) => result.results);
  }

  async scriptMigrationTag(workerName: string) {
    await this.lease?.();
    if (this.namespace === null) {
      if (this.app?.status === "active" || this.app?.status === "disabled") {
        throw new DeployError(
          "APP_ALREADY_INSTALLED",
          409,
          "This app is already installed. Open it from your Gateway; use the CLI to update it.",
        );
      }
      let exists = true;
      try {
        await this.cf.scripts.settings(workerName);
      } catch (error) {
        if (!isCloudflareNotFound(error)) throw error;
        exists = false;
      }
      await this.lease?.();
      const recordedVersion = await claimBrowserWorker(workerName, exists);
      if (!exists) return undefined;
      const script = (await this.cf.scripts.list()).find(
        (item) => item.id === workerName,
      );
      if (!script)
        throw new DeployError(
          "WORKER_OWNED",
          409,
          "Cloudflare did not list the existing Worker's ownership. Nothing was uploaded.",
        );
      const app = this.app;
      if (
        !app ||
        !script.tags?.includes(`org-${app.organizationId}`) ||
        !script.tags.includes(`app-${app.appSlug}`)
      )
        throw new DeployError(
          "WORKER_OWNED",
          409,
          "A Worker with this name already exists outside this browser installer. Use the CLI to manage it.",
        );
      if (
        (recordedVersion || app.versionId) &&
        ![recordedVersion, app.versionId].includes(
          await this.servingVersionId(workerName),
        )
      )
        throw new DeployError(
          "WORKER_CHANGED",
          409,
          "This Worker changed outside the browser installer. Use the CLI to reconcile it.",
        );
      return script.migration_tag ?? null;
    }
    try {
      const details = await this.cf.dispatchScripts.get(
        this.namespace,
        workerName,
      );
      return details.script.migration_tag ?? null;
    } catch (error) {
      if (isCloudflareNotFound(error)) return undefined;
      throw error;
    }
  }

  async uploadAssets(
    workerName: string,
    files: Parameters<DeployerPort["uploadAssets"]>[1],
  ): Promise<string> {
    await this.lease?.();
    if (this.namespace === null)
      return this.cf.workerAssets.upload(workerName, files);
    return this.cf.dispatchAssets.upload(this.namespace, workerName, files);
  }

  async upload(
    workerName: string,
    upload: Parameters<DeployerPort["upload"]>[1],
  ): Promise<{ versionId: string }> {
    await this.lease?.();
    if (this.namespace === null) {
      await this.cf.scripts.upload(workerName, upload);
      // Account-script etags hash the content; the CLI records deployment UUIDs.
      const versionId = await this.servingVersionId(workerName);
      await this.lease?.();
      await recordBrowserWorkerVersion(workerName, versionId);
      await this.lease?.();
      await this.cf.scripts.disableSubdomain(workerName);
      return { versionId };
    }
    const script = await this.cf.dispatchScripts.upload(
      this.namespace,
      workerName,
      upload,
    );
    // A namespaced upload deploys at once; its etag names the version.
    return { versionId: script.etag ?? script.id };
  }

  /** Account Workers and the CLI identify a live version through deployments. */
  private async servingVersionId(workerName: string): Promise<string> {
    const { deployments } = await this.cf.scripts.deployments(workerName);
    const newest = deployments.sort((a, b) =>
      b.created_on.localeCompare(a.created_on),
    )[0];
    const version = newest?.versions.find((item) => item.percentage === 100);
    if (!version?.version_id)
      throw new DeployError(
        "DEPLOYER_NOT_CONFIGURED",
        502,
        `Cloudflare did not return one serving version for ${workerName}. Reconcile it with the CLI.`,
      );
    return version.version_id;
  }

  async bindings(workerName: string) {
    if (this.namespace === null) {
      const { bindings } = await this.cf.scripts.settings(workerName);
      if (!Array.isArray(bindings))
        throw new DeployError(
          "BINDINGS_MISMATCH",
          502,
          "Cloudflare did not return the Worker's bindings.",
        );
      return bindings;
    }
    return this.cf.dispatchScripts.bindings(this.namespace, workerName);
  }

  async deleteScript(workerName: string): Promise<void> {
    await this.lease?.();
    try {
      if (this.namespace === null) {
        await this.cf.scripts.delete(workerName);
        return;
      }
      await this.cf.dispatchScripts.delete(this.namespace, workerName, {
        force: true,
      });
    } catch (error) {
      if (!isCloudflareNotFound(error)) throw error;
    }
  }

  /** Bind the private Worker and publish its hostname on the Gateway, as the CLI does. */
  async publishBoundApp(
    app: AppRow,
    gatewayUrl: string,
    renewApp: () => Promise<void>,
  ) {
    if (this.namespace !== null || !app.hostname || !app.workerName)
      throw new DeployError(
        "DEPLOYER_NOT_CONFIGURED",
        503,
        "A self-hosted app needs its Worker and hostname.",
      );
    const hostname = app.hostname;
    const workerName = app.workerName;
    const gatewayHost = new URL(gatewayUrl).hostname;
    if (!hostname.endsWith(`.${gatewayHost}`))
      throw new DeployError(
        "DEPLOYER_NOT_CONFIGURED",
        503,
        "App hosts must be below this Gateway's hostname.",
      );
    await withInstallLease(
      "gateway",
      "gateway.reconcile",
      async (renewGateway) => {
        const renew = async () => {
          await renewApp();
          await renewGateway();
        };
        await renew();
        // This Gateway's own Worker (a named Gateway binds apps on its own, never the default's).
        const gatewayWorker = gatewayNamesOf(env).worker;
        const primary = (await this.cf.scripts.domains(gatewayHost)).find(
          (domain) => domain.service === gatewayWorker,
        );
        if (!primary)
          throw new DeployError(
            "DEPLOYER_NOT_CONFIGURED",
            503,
            "This account has no Custom Domain for the Gateway.",
          );
        const domains = await this.cf.scripts.domains(hostname);
        if (domains.some((domain) => domain.service !== gatewayWorker))
          throw new DeployError(
            "HOSTNAME_TAKEN",
            409,
            "Another Worker owns the app's hostname.",
          );
        if (
          !domains.length &&
          (await this.cf.scripts.dnsRecords(primary.zone_id, hostname)).some(
            (record) =>
              ["A", "AAAA", "CNAME", "NS", "HTTPS", "SVCB"].includes(
                record.type,
              ),
          )
        )
          throw new DeployError(
            "HOSTNAME_TAKEN",
            409,
            "DNS already answers for this app's hostname. Choose another app id.",
          );
        await renew();
        const current = await this.cf.scripts.settings(gatewayWorker);
        if (!Array.isArray(current.bindings))
          throw new DeployError(
            "DEPLOYER_NOT_CONFIGURED",
            502,
            "Cloudflare did not return the Gateway's bindings. Nothing was replaced.",
          );
        const bindingName = `APP__${workerName}`;
        const present = current.bindings.find(
          (binding) => binding.name === bindingName,
        );
        if (
          present &&
          (present.type !== "service" ||
            present.service !== workerName ||
            (present.entrypoint && present.entrypoint !== "default"))
        )
          throw new DeployError(
            "BINDING_OWNED",
            409,
            "The Gateway already uses this app binding for something else.",
          );
        if (!present) {
          await renew();
          await this.cf.scripts.patchSettings(gatewayWorker, {
            bindings: [
              ...current.bindings.map((binding) => ({
                type: "inherit" as const,
                name: binding.name,
              })),
              { type: "service", name: bindingName, service: workerName },
            ],
          });
        }
        await renew();
        if (!domains.length)
          await this.cf.scripts.attachDomain({
            hostname,
            service: gatewayWorker,
            zone_id: primary.zone_id,
          });
        await renew();
        const verified = (await this.bindings(gatewayWorker)).find(
          (binding) => binding.name === bindingName,
        );
        if (verified?.type !== "service" || verified.service !== workerName)
          throw new DeployError(
            "BINDINGS_MISMATCH",
            502,
            "Cloudflare did not retain the app's Gateway binding. Try again.",
          );
        const versionId = await this.servingVersionId(gatewayWorker);
        await renew();
        await recordBrowserGatewayDeployment(
          versionId,
          workerName,
          hostname,
          app.deployedByActor,
        );
      },
    );
  }
}
