// `handleAsNodeRequest` is documented
// (https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/) and
// in the runtime types `cf workers types` generates, but not yet in the
// @cloudflare/workers-types the SDK compiles against. Remove this once it is.
declare module "cloudflare:node" {
  export function handleAsNodeRequest(
    port: number,
    request: Request,
  ): Promise<Response>;
}
