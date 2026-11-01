/**
 * Which Gateway this Worker is, by name (packages/perimeter
 * manifest/gatewayNames.ts): the deploy patches EVERYAPP_GATEWAY_NAME in
 * (empty for the default Gateway, `every-app-gateway`; `demo` for
 * `every-app-gateway-demo`), and everything here that names an
 * account-wide resource (an app's Worker at registration, the Gateway's
 * own Worker in a Gateway app install) takes it from here, never from a
 * constant. Dev, with nothing set, is the default Gateway.
 */
import {
  gatewayNames,
  isValidGatewayName,
  type GatewayNames,
} from "@every-app/perimeter/manifest";

interface GatewayNameEnv {
  EVERYAPP_GATEWAY_NAME?: string;
}

/** This Gateway's name, or null for the default one (unset, empty, or not a name at all). */
export function gatewayNameOf(env: GatewayNameEnv): string | null {
  const name = env.EVERYAPP_GATEWAY_NAME?.trim().toLowerCase() ?? "";
  return name && isValidGatewayName(name) ? name : null;
}

/** Every name this Gateway takes (its Worker above all). */
export function gatewayNamesOf(env: GatewayNameEnv): GatewayNames {
  return gatewayNames(gatewayNameOf(env));
}
