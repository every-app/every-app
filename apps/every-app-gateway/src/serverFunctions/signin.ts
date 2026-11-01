import { createServerFn } from "@tanstack/react-start";
import { organizationAdminMiddleware } from "@/middleware/auth";
import { publicErrorMiddleware } from "@/middleware/publicError";
import * as signInProviders from "@/server/sign-in-providers";

// Manage workspace → Sign-in: which sign-in providers are on, which need
// setup and what to register at each. An owner's or admin's to read, like
// the rest of the page. There is deliberately no write beside it: the
// settings are Worker secrets the Gateway can't write to itself (`everyapp
// signin add`), so a stolen admin session can't add a way in (threat model
// B10). The listing names settings and says whether each is set, never a
// value.

/** Every catalog provider's state, with passwords and Access beside them. */
export const listSignInProviders = createServerFn()
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .handler(async () => signInProviders.listSignInProviders());
