import { createServerFn } from "@tanstack/react-start";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const joinWaitlist = createServerFn({ method: "POST" })
  .inputValidator((email: string) => {
    const normalized = email.trim().toLowerCase();
    if (!emailPattern.test(normalized) || normalized.length > 254) {
      throw new Error("Please enter a valid email address.");
    }
    return normalized;
  })
  .handler(async ({ data: email }) => {
    const { env } = await import("cloudflare:workers");
    await env.DB.prepare(
      "INSERT INTO waitlist_signups (email) VALUES (?1) ON CONFLICT (email) DO NOTHING",
    )
      .bind(email)
      .run();
    return { ok: true };
  });
