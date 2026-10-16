/**
 * The DeployerPort over Cloudflare's REST API (@every-app/cf-rest): one
 * account, one dispatch namespace, the gateway's CF_DEPLOY_TOKEN. Built
 * per deploy from the env, and refused (503) when any of the three is
 * missing: a gateway with the launch gate open but no deployer configured
 * deploys nothing.
 */
import {
  createCloudflareRest,
  isCloudflareNotFound,
  type CloudflareRest,
} from "@every-app/cf-rest";
import { DeployError } from "./errors";
import type { DeployerPort } from "./port";

interface DeployerEnv {
  CF_DEPLOY_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  DISPATCH_NAMESPACE?: string;
}

export class CfRestDeployer implements DeployerPort {
  constructor(
    private readonly cf: CloudflareRest,
    private readonly namespace: string,
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

  async createDatabase(name: string): Promise<string> {
    return (await this.cf.d1.create(name)).uuid;
  }

  async findDatabase(name: string): Promise<string | null> {
    return (await this.cf.d1.findByName(name))?.uuid ?? null;
  }

  async batch(
    databaseId: string,
    statements: Parameters<DeployerPort["batch"]>[1],
  ) {
    const results = await this.cf.d1.batch(databaseId, [...statements]);
    return results.map((result) => result.results);
  }

  async scriptMigrationTag(workerName: string) {
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

  uploadAssets(
    workerName: string,
    files: Parameters<DeployerPort["uploadAssets"]>[1],
  ): Promise<string> {
    return this.cf.dispatchAssets.upload(this.namespace, workerName, files);
  }

  async upload(
    workerName: string,
    upload: Parameters<DeployerPort["upload"]>[1],
  ): Promise<{ versionId: string }> {
    const script = await this.cf.dispatchScripts.upload(
      this.namespace,
      workerName,
      upload,
    );
    // A namespaced upload deploys at once; its etag names the version.
    return { versionId: script.etag ?? script.id };
  }

  bindings(workerName: string) {
    return this.cf.dispatchScripts.bindings(this.namespace, workerName);
  }

  async deleteScript(workerName: string): Promise<void> {
    try {
      await this.cf.dispatchScripts.delete(this.namespace, workerName, {
        force: true,
      });
    } catch (error) {
      if (!isCloudflareNotFound(error)) throw error;
    }
  }
}
