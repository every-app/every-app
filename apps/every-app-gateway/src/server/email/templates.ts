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
    subject: "Verify your Every App email",
    text: `Use this link to verify your email address: ${url}`,
    html: `<p>Use this link to verify your email address:</p><p>${link(url, url)}</p>`,
  };
}

export function passwordResetEmail(url: string): Email {
  return {
    subject: "Reset your Every App password",
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
