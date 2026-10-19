import {
  isReservedAppSecretName,
  RESERVED_APP_SECRET_NAMES_TEXT,
} from "@every-app/sdk/internal";
import { EveryAppError } from "@/lib/errors";

/**
 * Refuse a secret name the app can't use, before anything is deployed: the
 * deploy sends GATEWAY_URL and EVERY_APP_ORG_ID itself and builds in the
 * identity settings and the gateway binding, so a secret of the app can't
 * take those names, nor any name in the platform's namespaces (the same
 * rule the manifest's `secrets` follow).
 */
export function assertAppSecretName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new EveryAppError(
      "SECRET_NAME_INVALID",
      `"${name}" can't be a secret's name: use letters, digits and underscores, starting with a letter, e.g. GITHUB_TOKEN.`,
    );
  }
  if (isReservedAppSecretName(name)) {
    throw new EveryAppError(
      "SECRET_NAME_RESERVED",
      `${name} is set by everyapp itself (with ${RESERVED_APP_SECRET_NAMES_TEXT}); pick another name.`,
    );
  }
}
