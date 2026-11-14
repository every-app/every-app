import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import {
  organizationAdminMiddleware,
  organizationMemberMiddleware,
} from "@/middleware/auth";
import { publicErrorMiddleware } from "@/middleware/publicError";
import { composioSwitchSchema } from "@/schemas/composio";
import { buildComposioContext } from "@/server/composio/connect";
import * as composio from "@/server/composio/service";
import { signedIn } from "@/server/oauth/flow";

// Composio (docs/design/2026-11-composio.md). The switch is the
// organization's, an owner's or admin's, from Manage workspace →
// Providers. A link is one person's, from Your connections → Accounts or
// the Composio page: every member links, reads and unlinks their own and
// nobody else's. The key and the sign-in id never leave the server; the
// sign-in's page is returned once, by the start, to the person who
// started it.

/** Whether Composio is on, and how many links and connections turning it off would delete. */
export const getComposioSwitch = createServerFn()
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .handler(({ context }) => composio.composioSwitch(context.org));

/**
 * Turn Composio on or off for the organization. Off deletes every link
 * and every connection made through it, so without `confirm` it answers
 * `needsConfirm` with their counts while any exists, and changes nothing.
 */
export const setComposioSwitch = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => composioSwitchSchema.parse(data))
  .handler(({ data, context }) =>
    data.on
      ? composio.setComposio(context.org, true)
      : composio.turnComposioOff(context.org, data.confirm === true),
  );

/** Whether Composio is on, and the caller's link: read from the Gateway alone. */
export const getComposioStatus = createServerFn()
  .middleware([publicErrorMiddleware, organizationMemberMiddleware])
  .handler(({ context }) => composio.composioStatus(context.org));

/** Start a sign-in at Composio: its page, and when it expires. */
export const startComposioLink = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationMemberMiddleware])
  .handler(({ context }) => composio.startComposioLink(context.org));

/** Whether the caller approved the sign-in they started; links when they did. */
export const finishComposioLink = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationMemberMiddleware])
  .handler(async ({ context }) => {
    const result = await composio.finishComposioLink(context.org);
    return { state: result.state };
  });

/** Unlink the caller's Composio: the key and every connection they made through it. */
export const unlinkComposio = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationMemberMiddleware])
  .handler(async ({ context }) => {
    await composio.unlinkComposio(context.org);
    return { ok: true as const };
  });

const composioContextSchema = z.object({
  // The one-use state in the Composio page's own query.
  state: z.string().min(1).max(256),
});

/**
 * What the Composio page shows: the app asking to use an account from the
 * signed-in person's Composio, and what they do next (sign in at Composio,
 * connect a missing service there, or allow). POST, like every server
 * function that reads a session for a decision; it reads the person's
 * accounts from Composio each time. Changes no connection: the page's
 * form posts the decision to `/connect/<provider>/composio`.
 */
export const getComposioContext = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware])
  .validator((data: unknown) => composioContextSchema.parse(data))
  .handler(async ({ data }) => {
    const person = await signedIn(getRequest());
    if (!person) return { ok: false as const, signedOut: true as const };
    return buildComposioContext(person, data.state);
  });
