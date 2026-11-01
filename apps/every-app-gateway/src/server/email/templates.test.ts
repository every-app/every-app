import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  invitationEmail,
  passwordResetEmail,
  verificationEmail,
} from "./templates";

describe("email templates", () => {
  it("escapes markup in everything an invitation interpolates", () => {
    const email = invitationEmail({
      organizationName: `<img src=x onerror="alert(1)"> & Co's`,
      inviterEmail: `"evil"<script>@example.com`,
      url: "https://gateway.example.com/accept-invitation?token=einv_a&b=<c>",
    });

    expect(email.html).not.toContain("<img");
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; Co&#39;s",
    );
    expect(email.html).toContain("&quot;evil&quot;&lt;script&gt;@example.com");
    expect(email.html).toContain(
      'href="https://gateway.example.com/accept-invitation?token=einv_a&amp;b=&lt;c&gt;"',
    );
  });

  it("keeps an organization name on one line of the subject and text", () => {
    const email = invitationEmail({
      organizationName: "Acme\r\nBcc: victim@example.com\u202e",
      inviterEmail: "admin@example.com\n",
      url: "https://gateway.example.com/accept-invitation?token=t",
    });

    expect(email.subject).toBe(
      "You have been invited to Acme Bcc: victim@example.com",
    );
    expect(email.subject).not.toMatch(/[\r\n\u202e]/);
    expect(email.text).toBe(
      "admin@example.com invited you to join Acme Bcc: victim@example.com. Accept the invitation: https://gateway.example.com/accept-invitation?token=t",
    );
  });

  it("escapes the link in verification and reset mail", () => {
    const url = 'https://gateway.example.com/x?a=1&b="2"';
    for (const email of [verificationEmail(url), passwordResetEmail(url)]) {
      expect(email.html).toContain(
        'href="https://gateway.example.com/x?a=1&amp;b=&quot;2&quot;"',
      );
      expect(email.html).not.toContain('"2"');
      expect(email.text).toContain(url);
    }
  });

  it("escapes the five HTML metacharacters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});
