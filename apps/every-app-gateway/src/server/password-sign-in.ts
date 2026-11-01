import {
  accessConfigFromEnv,
  isPasswordSignInOn,
} from "@/auth/cloudflare-access";
import { PublicError } from "./errors";

/**
 * Refuse to hand out password reset links while password sign-in is off
 * (EMAIL_PASSWORD_SIGN_IN=false with Cloudflare Access sign-in): the reset
 * page would refuse them anyway.
 */
export async function requirePasswordSignIn(): Promise<void> {
  if (!(await isPasswordSignInOn(accessConfigFromEnv()))) {
    throw new PublicError(
      "PASSWORD_SIGN_IN_DISABLED",
      "Password sign-in is turned off on this gateway",
    );
  }
}
