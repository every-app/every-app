/**
 * `GATEWAY_DEPLOYMENT_MODE`: `self_hosted` for a gateway the operator runs
 * in their own Cloudflare account (the CLI sets it at install), `hosted`
 * for the hosted tier (ADR-0001). Anything else, unset included, is
 * `invalid`, and whatever depends on the mode stays off.
 */
type DeploymentMode = "self_hosted" | "hosted";

export function resolveDeploymentMode(
  rawMode: string | undefined,
): DeploymentMode | "invalid" {
  const normalized = rawMode?.trim().toLowerCase();
  return normalized === "self_hosted" || normalized === "hosted"
    ? normalized
    : "invalid";
}
