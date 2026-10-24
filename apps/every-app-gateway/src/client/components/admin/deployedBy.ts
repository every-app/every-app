/**
 * Who deployed an app, in plain words. The registry records an actor
 * (`apps.deployed_by_actor`): the Cloudflare login's email from the CLI, or
 * the installer's from the browser install; `api-token:<account id>` from
 * the CLI under CLOUDFLARE_API_TOKEN (CI); `deploy-key:<token id>` from the
 * hosted deploy API. An id names nothing to a person, so the two machine
 * actors say what deployed; an email reads as is.
 */
export function deployedBy(actor: string | null): string | null {
  if (!actor) return null;
  if (actor.startsWith("api-token:")) return "Deployed with an API token";
  if (actor.startsWith("deploy-key:")) return "Deployed with a deploy key";
  return `Deployed by ${actor}`;
}
