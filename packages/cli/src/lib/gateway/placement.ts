/**
 * Where the Gateway Worker runs, chosen with `--placement` on `setup` or
 * `update` and recorded on the install row, so every later upload keeps it:
 * `smart` (Cloudflare's Smart Placement), a cloud region (`aws:us-east-1`),
 * or `off`, Cloudflare's default of wherever a request arrives.
 */
import { EveryAppError } from "@/lib/errors";

/**
 * The clouds Cloudflare's placement names, as `aws:us-east-1`. Nothing later
 * checks this: cf's schema takes any string, and Cloudflare's own refusal
 * would come after the Gateway's database has migrated.
 */
const CLOUD_REGION = /^(aws|gcp|azure):[a-z0-9-]+$/;

/** `smart`, `off` or a cloud region, as parsePlacement gives it. */
export type GatewayPlacement = string;

/** --placement, read the way it was meant; anything else is refused in the flag's name. */
export function parsePlacement(value: string): GatewayPlacement {
  const placement = value.trim().toLowerCase();
  if (placement === "smart" || placement === "off" || CLOUD_REGION.test(placement)) return placement;
  throw new EveryAppError(
    "INVALID_PLACEMENT",
    `--placement must be smart, off or a cloud region, not "${value}"\nA cloud region starts with aws:, gcp: or azure:, like aws:us-east-1.`,
    { fix: "pass smart, off or a cloud region such as aws:us-east-1" },
  );
}

/** The choice as the Build Output's `placement`, which cf reads. */
export function placementConfig(placement: GatewayPlacement): { mode: "smart" | "off" } | { region: string } {
  return placement === "smart" || placement === "off" ? { mode: placement } : { region: placement };
}
