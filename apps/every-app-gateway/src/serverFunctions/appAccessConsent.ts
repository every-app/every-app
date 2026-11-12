import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { publicErrorMiddleware } from "@/middleware/publicError";
import { buildAppAccessContext } from "@/server/oauth/appAccessConsent";
import { signedIn } from "@/server/oauth/flow";

const appAccessContextSchema = z.object({
  // The one-use state in the Allow page's own query.
  state: z.string().min(1).max(256),
});

/**
 * What the Allow page shows: the app asking to use the signed-in person's
 * connection to a provider, and the scopes involved
 * (docs/design/2026-11-oauth-one-connection.md). POST, like every server
 * function that reads a session for a decision. Changes nothing: the
 * page's form posts the decision to `/connect/<provider>/allow`.
 */
export const getAppAccessContext = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware])
  .validator((data: unknown) => appAccessContextSchema.parse(data))
  .handler(async ({ data }) => {
    const person = await signedIn(getRequest());
    if (!person) return { ok: false as const, signedOut: true as const };
    return buildAppAccessContext(person, data.state);
  });
