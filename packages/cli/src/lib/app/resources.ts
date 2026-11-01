import { createAiGateway, findAiGateway, updateAiGateway } from "@/lib/cf/aiGateway";
import { isCfError } from "@/lib/cf/errors";
import { createHyperdrive, findHyperdrive, updateHyperdrive } from "@/lib/cf/hyperdrive";
import { createQueue, getQueue, listQueues } from "@/lib/cf/queues";
import { createR2Bucket, findR2Bucket } from "@/lib/cf/r2";
import {
  createD1,
  createKv,
  findD1,
  findKv,
} from "@/lib/cf/resources";
import type { CfRunner } from "@/lib/cf/runner";
import { createStoreSecret, findStoreSecret, listSecretsStores } from "@/lib/cf/secretsStore";
import { createVectorizeIndex, getVectorizeIndex } from "@/lib/cf/vectorize";
import { getWorkerDeployment } from "@/lib/cf/workers";
import { EveryAppError } from "@/lib/errors";
import { CLI, thisCommand } from "@/lib/output/command";
import type { InstallTarget } from "./installBuildOutput";

import { createResourceProvisioner } from "@every-app/perimeter/install";
const installer = createResourceProvisioner<CfRunner>({
  Error: EveryAppError,
  findD1,
  createD1,
  findKv,
  createKv,
  findR2Bucket,
  createR2Bucket,
  getWorkerDeployment,
  findHyperdrive,
  createHyperdrive,
  updateHyperdrive,
  listQueues,
  getQueue,
  createQueue,
  getVectorizeIndex,
  createVectorizeIndex,
  findAiGateway,
  createAiGateway,
  updateAiGateway,
  listSecretsStores,
  findStoreSecret,
  createStoreSecret,
  isCfError,
  CLI,
  thisCommand,
});
export async function claimAppWorker(...args: Parameters<typeof installer.claimAppWorker>): Promise<void> {
  try {
    await installer.claimAppWorker(...args);
  } catch (error) {
    throw EveryAppError.fromInstallation(error);
  }
}

export async function ensureAppBuckets(...args: Parameters<typeof installer.ensureAppBuckets>): Promise<string[]> {
  try {
    return await installer.ensureAppBuckets(...args);
  } catch (error) {
    throw EveryAppError.fromInstallation(error);
  }
}
export async function provisionAppResources(
  ...args: Parameters<typeof installer.provisionAppResources>
): Promise<InstallTarget["resources"]> {
  try {
    return await installer.provisionAppResources(...args);
  } catch (error) {
    throw EveryAppError.fromInstallation(error);
  }
}
