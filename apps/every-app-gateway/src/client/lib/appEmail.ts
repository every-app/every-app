import type { AppWithAccessCount } from "@/types/app";

/** A JSON string[] column as a list; none when unset or unreadable. */
function list(value: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(value ?? "null");
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

/** What the app's installation sends as and receives at, and what its manifest declares (`everyapp email set` sets the lists). */
export function appEmail(
  app: Pick<AppWithAccessCount, "manifest" | "emailSenders" | "emailInbound">,
) {
  let manifest: {
    capabilities?: Record<string, { access?: unknown }>;
    email?: { inbound?: unknown };
  } = {};
  try {
    manifest = JSON.parse(app.manifest ?? "{}");
  } catch {
    // An unreadable snapshot declares nothing.
  }
  return {
    sends: manifest.capabilities?.["email"]?.access === "write",
    receives: manifest.email?.inbound === true,
    senders: list(app.emailSenders),
    inbound: list(app.emailInbound),
  };
}
