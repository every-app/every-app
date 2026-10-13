import {
  accessConfigFromEnv,
  joinsWithoutInvitation,
} from "@/auth/cloudflare-access";

/**
 * Whether Cloudflare Access would let this person straight back in after
 * their account is deleted: their email domain is in
 * CLOUDFLARE_ACCESS_AUTO_JOIN_DOMAINS, or the outer ring lets everyone it
 * admits join. Deleting them wouldn't keep them out; deactivating does.
 */
export function accessWouldLetBackIn(email: string): boolean {
  return joinsWithoutInvitation(email, accessConfigFromEnv());
}
