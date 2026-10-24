/**
 * The gateway home (launcher) URL, derived at runtime from the current host.
 *
 * In v2 the app always lives on a subdomain of the gateway — strip the first
 * label and you have the gateway's base host. This works identically for
 * production (`todo.example.com` -> `example.com`), `everyapp dev`
 * (`todo.localhost:8787` -> `localhost:8787`), and portless worktrees
 * (`todo.fix-ui.everyapp.localhost` -> `fix-ui.everyapp.localhost`).
 */
export function gatewayHomeUrl(): string {
  if (typeof window === "undefined") return "/";
  const host = window.location.host;
  const dot = host.indexOf(".");
  const baseHost = dot > 0 ? host.slice(dot + 1) : host;
  return `${window.location.protocol}//${baseHost}/`;
}
