/**
 * @every-app/sdk/dev — the well-known dev identity: the keypair `everyapp dev`
 * signs with, its issuer and its key id. For the platform's local dev tools
 * (the CLI, `@every-app/perimeter/dev`); never imported by a Worker.
 */
export {
  DEV_ISSUER,
  DEV_PRIVATE_KEY_PEM,
  DEV_PUBLIC_KEY_PEM,
} from "./keypair.js";
export { IDENTITY_DEV_KEY_ID } from "../internal/protocol.js";
