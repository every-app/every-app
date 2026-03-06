import { env } from "cloudflare:workers";

type SendEmailOptions = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

function requireEmailConfig() {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.EMAIL_FROM?.trim();

  if (!apiKey || !from) {
    throw new Error(
      "Email is not configured. Set RESEND_API_KEY and EMAIL_FROM.",
    );
  }

  return { apiKey, from };
}

export async function sendEmail(options: SendEmailOptions): Promise<void> {
  const { apiKey, from } = requireEmailConfig();

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [options.to],
      subject: options.subject,
      text: options.text,
      html: options.html,
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(
      `Failed to send email (${response.status} ${response.statusText}): ${details}`,
    );
  }
}
