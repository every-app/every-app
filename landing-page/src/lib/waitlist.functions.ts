import { createServerFn } from "@tanstack/react-start";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The "Keep me posted" form: the address becomes a Loops contact (the
 * EveryApp team's audience), subscribed, with the source recorded, so the
 * release announcements go out from Loops. A contact that already exists
 * is a success too (Loops answers 409); nothing is stored on this Worker.
 * `LOOPS_API_KEY` is a Worker secret (`wrangler secret put LOOPS_API_KEY`).
 */
export const joinWaitlist = createServerFn({ method: "POST" })
  .validator((email: string) => {
    const normalized = email.trim().toLowerCase();
    if (!emailPattern.test(normalized) || normalized.length > 254) {
      throw new Error("Please enter a valid email address.");
    }
    return normalized;
  })
  .handler(async ({ data: email }) => {
    const { env } = await import("cloudflare:workers");
    // A secret, so `wrangler types` doesn't list it; `.dev.vars` sets it locally.
    const apiKey = (env as { LOOPS_API_KEY?: string }).LOOPS_API_KEY;
    if (!apiKey) throw new Error("The sign-up form is not configured.");
    const response = await fetch(
      "https://app.loops.so/api/v1/contacts/create",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          source: "everyapp.com",
          subscribed: true,
          userGroup: "Keep me posted",
        }),
      },
    );
    // 409: the contact exists already; the person is on the list either way.
    if (!response.ok && response.status !== 409) {
      throw new Error(
        `Could not save the address (Loops answered ${response.status}).`,
      );
    }
    return { ok: true };
  });
