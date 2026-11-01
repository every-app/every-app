/**
 * The gateway's emails. Every value put into one is escaped for where it
 * goes: an organization is named by whoever signed up, and an inviter's
 * address is whatever they registered, so either could otherwise carry
 * markup into someone else's inbox, or a line break into a subject.
 */

type Email = { subject: string; text: string; html: string };

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/**
 * A value on one line of plain text (a subject, or a sentence of the text
 * part): control and invisible formatting characters become spaces, so it
 * can't break the line, start a header or reorder what is around it.
 */
function oneLine(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function link(url: string, label: string): string {
  return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

export function verificationEmail(url: string): Email {
  return {
    subject: "Verify your EveryApp email",
    text: `Use this link to verify your email address: ${url}`,
    html: `<p>Use this link to verify your email address:</p><p>${link(url, url)}</p>`,
  };
}

export function passwordResetEmail(url: string): Email {
  return {
    subject: "Reset your EveryApp password",
    text: `Use this link to reset your password: ${url}`,
    html: `<p>Use this link to reset your password:</p><p>${link(url, url)}</p>`,
  };
}

export function invitationEmail({
  organizationName,
  inviterEmail,
  url,
}: {
  organizationName: string;
  inviterEmail: string;
  url: string;
}): Email {
  const org = oneLine(organizationName);
  const inviter = oneLine(inviterEmail);
  return {
    subject: `You have been invited to ${org}`,
    text: `${inviter} invited you to join ${org}. Accept the invitation: ${url}`,
    html: `<p>${escapeHtml(inviter)} invited you to join ${escapeHtml(org)}.</p><p>${link(url, "Accept invitation")}</p>`,
  };
}

/**
 * An event notice (server/events/email-sink.ts): the catalogue's summary
 * as the subject under the organization's name, the fields a person reads
 * as a short list, and one link to the admin page that acts on it. The
 * summary and every field come from event data that members and apps
 * wrote, so each is escaped for where it goes.
 */
export function eventEmail({
  organizationName,
  summary,
  fields,
  url,
  pageLabel,
}: {
  organizationName: string;
  summary: string;
  fields: readonly { label: string; value: string }[];
  url: string;
  pageLabel: string;
}): Email {
  const org = oneLine(organizationName);
  const line = oneLine(summary);
  const textFields = fields
    .map((field) => `${oneLine(field.label)}: ${oneLine(field.value)}`)
    .join("\n");
  const htmlFields = fields
    .map(
      (field) =>
        `<li><strong>${escapeHtml(oneLine(field.label))}:</strong> ${escapeHtml(oneLine(field.value))}</li>`,
    )
    .join("");
  return {
    subject: `[${org}] ${line}`,
    text: `${line}\n\n${textFields ? `${textFields}\n\n` : ""}${pageLabel}: ${url}\n\nYou get this because you are an owner or admin of ${org}. Change it under Manage workspace, Events.`,
    html: `<p>${escapeHtml(line)}</p>${htmlFields ? `<ul>${htmlFields}</ul>` : ""}<p>${link(url, pageLabel)}</p><p style="color:#666;font-size:12px">You get this because you are an owner or admin of ${escapeHtml(org)}. Change it under Manage workspace, Events.</p>`,
  };
}
