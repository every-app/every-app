import { env } from "cloudflare:workers";
import {
  validateManifest,
  ManifestError,
  type EveryAppManifest,
} from "@every-app/perimeter/manifest";
import { AppRepository } from "@/server/repositories/AppRepository";
import { OrganizationMembersRepository } from "@/server/repositories/OrganizationMembersRepository";
import { OrganizationRepository } from "@/server/repositories/OrganizationRepository";

type RegisterAppInput = {
  organizationId: string;
  appSlug: string;
  name: string;
  description: string;
  workerName: string;
  manifest: unknown;
};

type RegisterAppResult = {
  appId: string;
  appSlug: string;
  hostname: string;
  existingApp: boolean;
  defaultAccess: boolean;
  grantedUserCount: number;
};

export class AppRegistrationError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor({
    message,
    status,
    code,
  }: {
    message: string;
    status: number;
    code?: string;
  }) {
    super(message);
    this.name = "AppRegistrationError";
    this.status = status;
    this.code = code;
  }
}

const DNS_LABEL_PATTERN = /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function hostnameFor(appSlug: string, organizationSlug: string): string {
  if (!env.GATEWAY_URL) {
    throw new AppRegistrationError({
      status: 500,
      message:
        "Gateway has no GATEWAY_URL configured; cannot derive app hostname",
    });
  }

  let gatewayHost: string;
  try {
    gatewayHost = new URL(env.GATEWAY_URL).host.toLowerCase();
  } catch {
    throw new AppRegistrationError({
      status: 500,
      message:
        "Gateway has invalid GATEWAY_URL configured; cannot derive app hostname",
    });
  }

  const appLabel = `${appSlug.trim()}-${organizationSlug.trim()}`.toLowerCase();
  if (!DNS_LABEL_PATTERN.test(appLabel)) {
    throw new AppRegistrationError({
      status: 400,
      code: "INVALID_APP_HOSTNAME",
      message: `App id and organization slug must form a valid DNS label of at most 63 characters; received "${appLabel}".`,
    });
  }

  return `${appLabel}.${gatewayHost}`;
}

function validateRegistryManifest(
  rawManifest: unknown,
  appSlug: string,
): EveryAppManifest {
  try {
    const manifest = validateManifest(rawManifest);
    if (manifest.id !== appSlug) {
      throw new AppRegistrationError({
        status: 400,
        message: `manifest.id "${manifest.id}" does not match appId "${appSlug}"`,
      });
    }
    return manifest;
  } catch (error) {
    if (error instanceof AppRegistrationError) {
      throw error;
    }

    throw new AppRegistrationError({
      status: 400,
      message:
        error instanceof ManifestError ? error.message : "Invalid manifest",
    });
  }
}

function validateWorkerName(workerName: string): void {
  if (!/^[a-z0-9-]+$/.test(workerName)) {
    throw new AppRegistrationError({
      status: 400,
      message: "workerName must be a valid worker script name",
    });
  }
}

async function register(data: RegisterAppInput): Promise<RegisterAppResult> {
  const manifest = validateRegistryManifest(data.manifest, data.appSlug);
  validateWorkerName(data.workerName);

  const organizationSlug = await OrganizationRepository.findSlugById(
    data.organizationId,
  );
  if (!organizationSlug) {
    throw new AppRegistrationError({
      status: 500,
      code: "ORGANIZATION_SLUG_NOT_FOUND",
      message: "Gateway could not resolve the deploying organization's slug",
    });
  }

  const hostname = hostnameFor(data.appSlug, organizationSlug);
  const [existingApp, hostnameOwner, workerNameOwner] = await Promise.all([
    AppRepository.findByAppSlug(data.appSlug, data.organizationId),
    AppRepository.findByHostname(hostname),
    AppRepository.findByWorkerName(data.workerName),
  ]);

  if (
    hostnameOwner &&
    (hostnameOwner.organizationId !== data.organizationId ||
      hostnameOwner.appSlug !== data.appSlug)
  ) {
    throw new AppRegistrationError({
      status: 409,
      code: "HOSTNAME_TAKEN",
      message: `The hostname "${hostname}" is already registered to another app on this gateway.`,
    });
  }

  // Worker names share one namespace per Cloudflare account: letting a second
  // app register the same workerName would route both hostnames to whichever
  // worker deployed last — and merge their D1/KV, since resource names derive
  // from the worker name. Fail closed until resource names are org-scoped.
  if (
    workerNameOwner &&
    (workerNameOwner.organizationId !== data.organizationId ||
      workerNameOwner.appSlug !== data.appSlug)
  ) {
    throw new AppRegistrationError({
      status: 409,
      code: "WORKER_NAME_TAKEN",
      message: `The worker name "${data.workerName}" is already registered to another app on this gateway. Choose a different app id.`,
    });
  }

  const appRowId = existingApp?.id ?? crypto.randomUUID();
  const manifestJson = JSON.stringify(manifest);

  if (existingApp) {
    await AppRepository.update(existingApp.id, {
      organizationId: data.organizationId,
      name: data.name,
      description: data.description,
      hostname,
      workerName: data.workerName,
      manifest: manifestJson,
      status: "active",
    });
  } else {
    const allUsers =
      await OrganizationMembersRepository.listMembersForOrganization(
        data.organizationId,
      );
    const initialAccess = allUsers.map((user) => ({
      id: crypto.randomUUID(),
      organizationId: data.organizationId,
      userId: user.id,
      appRowId,
      grantedBy: null,
    }));

    try {
      await AppRepository.createWithInitialAccess(
        {
          id: appRowId,
          organizationId: data.organizationId,
          appSlug: data.appSlug,
          name: data.name,
          description: data.description,
          hostname,
          workerName: data.workerName,
          manifest: manifestJson,
          tier: "service_binding",
          status: "active",
          isDefault: true,
        },
        initialAccess,
      );
    } catch (error) {
      // Two concurrent registrations can both pass the read-side checks; the
      // unique indexes catch the loser. Surface that as the same 409 a serial
      // request would have received instead of an opaque 500.
      if (
        error instanceof Error &&
        error.message.includes("UNIQUE constraint failed")
      ) {
        throw new AppRegistrationError({
          status: 409,
          code: "HOSTNAME_TAKEN",
          message: `The hostname "${hostname}" was just registered by another deploy on this gateway.`,
        });
      }
      throw error;
    }

    return {
      appId: appRowId,
      appSlug: data.appSlug,
      hostname,
      existingApp: false,
      defaultAccess: true,
      grantedUserCount: allUsers.length,
    };
  }

  return {
    appId: appRowId,
    appSlug: data.appSlug,
    hostname,
    existingApp: true,
    defaultAccess: existingApp.isDefault,
    grantedUserCount: 0,
  };
}

export const AppRegistrationService = {
  register,
} as const;
