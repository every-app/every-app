/** What `everyapp setup` does to the Gateway: its `setup.gateway` start event's `data.change`. */
export enum GatewayChange {
  Install = "install",
  /** An install that stopped before its first upload, picked up again. */
  Resume = "resume",
  Upgrade = "upgrade",
  /** The release it runs, bound to the apps its registry lists. */
  Repair = "repair",
  /** The release it runs, uploaded again (--redeploy). */
  Redeploy = "redeploy",
}
