import { EveryAppError } from "@/lib/errors";

/**
 * The deploy sends GATEWAY_URL and EVERY_APP_ORG_ID itself and builds in
 * the identity settings and the gateway binding, so a secret of the app can't
 * take those names, nor any name in the platform's namespaces.
 */
const RESERVED_NAMES = new Set(["GATEWAY_URL", "CF_VERSION_METADATA"]);
const RESERVED_PREFIXES = ["EVERYAPP_", "EVERY_APP_", "APP__"];

/** Refuse a secret name the app can't use, before anything is deployed. */
export function assertAppSecretName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new EveryAppError(
      "SECRET_NAME_INVALID",
      `"${name}" can't be a secret's name: use letters, digits and underscores, starting with a letter, e.g. GITHUB_TOKEN.`,
    );
  }
  const upper = name.toUpperCase();
  if (
    RESERVED_NAMES.has(upper) ||
    RESERVED_PREFIXES.some((prefix) => upper.startsWith(prefix))
  ) {
    throw new EveryAppError(
      "SECRET_NAME_RESERVED",
      `${name} is set by everyapp itself (with GATEWAY_URL and the EVERYAPP_*, EVERY_APP_* and APP__* names); pick another name.`,
    );
  }
}
