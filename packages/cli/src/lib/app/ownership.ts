/** The CLI and browser use the same account resource ownership ledger. */
export {
  describeResource,
  forgetOwnedResources,
  readAllRecordedResources,
  readOwnedResources,
  readResourcesOfKind,
  recordUploadedVersion,
  RESOURCE_LABELS,
} from "@every-app/perimeter/install";
import { EveryAppError } from "@/lib/errors";
import {
  recordOwnedResource as record,
  type InstallationDatabase,
  type OwnedResource,
} from "@every-app/perimeter/install";
export async function recordOwnedResource(
  db: InstallationDatabase,
  workerName: string,
  resource: OwnedResource,
): Promise<void> {
  try {
    await record(db, workerName, resource);
  } catch (error) {
    throw EveryAppError.fromInstallation(error);
  }
}
