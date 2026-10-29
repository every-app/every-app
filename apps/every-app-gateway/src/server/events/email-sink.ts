/**
 * The built-in email sink (docs/design/2026-10-events-out.md, section 6):
 * a subscription with `sink = "email"` delivers each event as one mail
 * per recipient to the organization's live owners (`recipients =
 * "owners"`) or owners and admins (`"admins"`), through the gateway's
 * own sender under the `notice` budgets. Recipients are always members:
 * the sink takes no address, so the gateway never mails outside the
 * organization. A gateway that can't send at all makes the delivery dead
 * at once (`email_not_configured`); a spent budget or a provider error is
 * a failed attempt that retries like a webhook's. Who was mailed is
 * remembered per delivery (a counter row that outlives the schedule), so
 * a retry after a partial send reaches the recipients still owed the mail
 * and nobody twice; the delivery is made once every recipient has it.
 */
import { logEvent } from "@every-app/perimeter";
import type { SendEmailOptions } from "@/server/email/sendEmail";
import { eventEmail } from "@/server/email/templates";
import { OrganizationMembersRepository } from "@/server/repositories/OrganizationMembersRepository";
import { RateLimitCounterRepository } from "@/server/repositories/RateLimitCounterRepository";
import { adminPathFor, eventEmailFields } from "./catalogue";
import type { SinkResult } from "./sink-result";
import { BRAND } from "@/brand";

/** The gateway's mail as the sink uses it; tests pass a fake. */
export interface EventMailer {
  /** A sender is set and a provider is selectable. */
  isConfigured(): boolean;
  send(options: SendEmailOptions): Promise<unknown>;
  /** An HMAC of an address: what logs name a recipient by. */
  recipientHash(address: string): Promise<string>;
}

/** How long "mailed" is remembered for a delivery: past its whole schedule. */
const MAILED_MARKER_TTL_MS = 3 * 24 * 60 * 60 * 1000;

function mailedKey(deliveryId: string, recipientHash: string): string {
  return `events:mailed:${deliveryId}:${recipientHash}`;
}

const PAGE_LABELS: Record<string, string> = {
  "/admin/usage": "Open Usage",
  "/admin/users": "Open Users",
  "/admin/activity": "Open Activity",
  "/admin/tokens": "Open Tokens",
  "/admin/apps": "Open Apps",
  "/settings/connections": "Open AI connections",
  "/admin/events": "Open Events",
};

/** The delivery error code for a refused send. */
function errorCodeOf(error: unknown): { code: string; dead: boolean } {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  switch (code) {
    case "EMAIL_BUDGET_EXHAUSTED":
      return { code: "email_budget_exhausted", dead: false };
    case "EMAIL_SENDER_NOT_CONFIGURED":
    case "EMAIL_BINDING_UNAVAILABLE":
      return { code: "email_not_configured", dead: true };
    default:
      return { code: "email_send_failed", dead: false };
  }
}

export async function sendEventEmail(
  input: {
    organizationId: string;
    organizationName: string;
    recipients: "owners" | "admins";
    type: string;
    summary: string;
    data: Record<string, unknown>;
    gatewayUrl: string;
    deliveryId: string;
  },
  mailer: EventMailer,
): Promise<SinkResult> {
  if (!mailer.isConfigured()) {
    return {
      ok: false,
      statusCode: null,
      error: "email_not_configured",
      dead: true,
    };
  }
  const admins = await OrganizationMembersRepository.listLiveOwnersAndAdmins(
    input.organizationId,
  );
  const recipients =
    input.recipients === "owners"
      ? admins.filter((member) => member.role === "owner")
      : admins;
  if (recipients.length === 0) {
    return { ok: false, statusCode: 0, error: "no_recipients", dead: true };
  }
  const path = adminPathFor(input.type);
  const mail = eventEmail({
    organizationName: input.organizationName,
    summary: input.summary,
    fields: eventEmailFields(input.type, input.data),
    url: `${input.gatewayUrl}${path}`,
    pageLabel: PAGE_LABELS[path] ?? `Open ${BRAND.name}`,
  });
  const hashes = new Map<string, string>();
  for (const recipient of recipients) {
    hashes.set(recipient.email, await mailer.recipientHash(recipient.email));
  }
  const mailedBefore = await RateLimitCounterRepository.read(
    [...hashes.values()].map((hash) => mailedKey(input.deliveryId, hash)),
  );
  let mailed = 0;
  let firstFailure: { code: string; dead: boolean } | null = null;
  for (const recipient of recipients) {
    const key = mailedKey(input.deliveryId, hashes.get(recipient.email)!);
    if (mailedBefore.has(key)) {
      mailed += 1;
      continue;
    }
    try {
      await mailer.send({ kind: "notice", to: recipient.email, ...mail });
      mailed += 1;
      // Best effort: a marker that isn't written risks one duplicate.
      await RateLimitCounterRepository.increment(
        [key],
        new Date(Date.now() + MAILED_MARKER_TTL_MS),
      ).catch(() => undefined);
    } catch (error) {
      // sendEmail logged the provider's refusal; the recipient is named
      // by hash, as the audit code names them.
      logEvent(
        "events.email_failed",
        {
          delivery: input.deliveryId,
          type: input.type,
          recipient: hashes.get(recipient.email),
          code: errorCodeOf(error).code,
        },
        "warn",
      );
      firstFailure ??= errorCodeOf(error);
    }
  }
  if (mailed === recipients.length) return { ok: true, statusCode: mailed };
  const code = firstFailure?.code ?? "email_send_failed";
  return {
    ok: false,
    statusCode: mailed,
    error:
      mailed > 0
        ? `partial: ${mailed} of ${recipients.length} mailed; ${code}`
        : code,
    dead: firstFailure?.dead ?? false,
  };
}
