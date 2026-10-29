import { OutputWorkerSchema } from "@cloudflare/config";
import { InstallationError } from "./error";
export const BUILD_OUTPUT_PATCH_PLACEHOLDER = "__EVERYAPP_PATCH__";

/** The same Cloudflare Build Output schema in both installation runtimes. */
export function validateWorkerBuildOutput(
  config: unknown,
  { requireDomain = false }: { requireDomain?: boolean } = {},
): void {
  const parsed = OutputWorkerSchema.safeParse(config);
  if (!parsed.success)
    throw new InstallationError(
      "INVALID_BUILD_OUTPUT",
      `The patched Worker config isn't valid Build Output: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}`,
    );
  if (JSON.stringify(config).includes(BUILD_OUTPUT_PATCH_PLACEHOLDER))
    throw new InstallationError(
      "INVALID_BUILD_OUTPUT",
      "The Worker config still has a deploy-time placeholder.",
    );
  if (requireDomain && !parsed.data.domains?.length)
    throw new InstallationError(
      "INVALID_BUILD_OUTPUT",
      "The gateway has no domain to deploy to.",
    );
}
