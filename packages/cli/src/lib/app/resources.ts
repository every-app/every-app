/** The shared resource provisioner (@every-app/perimeter/install resources.ts), through `cf`. */
import { createResourceProvisioner } from "@every-app/perimeter/install";
import { createAiGateway, findAiGateway, updateAiGateway } from "@/lib/cf/aiGateway";
import { isCfError } from "@/lib/cf/errors";
import { createHyperdrive, findHyperdrive, updateHyperdrive } from "@/lib/cf/hyperdrive";
import { createQueue, getQueue, listQueues } from "@/lib/cf/queues";
import { findArtifactsNamespace } from "@/lib/cf/artifacts";
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

export const resourceInstaller = createResourceProvisioner<CfRunner>({
  Error: EveryAppError,
  findD1,
  createD1,
  findKv,
  createKv,
  findR2Bucket,
  findArtifactsNamespace,
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
