/**
 * An email address with its local part hidden, for a page that names an
 * account before anyone has signed in: `b•••@example.com`. The first
 * character stays so the person recognizes their address; a one-character
 * local part shows only the dots (`•••@example.com`).
 */
export function maskEmail(email: string): string {
  const address = email.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  const local = at === -1 ? address : address.slice(0, at);
  const domain = at === -1 ? "" : address.slice(at);
  // Code points, not UTF-16 units: a surrogate pair is one character.
  const characters = [...local];
  const first = characters.length > 1 ? characters[0] : "";
  return `${first}•••${domain}`;
}
