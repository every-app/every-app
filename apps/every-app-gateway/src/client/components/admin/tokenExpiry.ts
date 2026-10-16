// The expiration picker shared by the deploy token and personal access token
// dialogs: a few presets, or a custom date and time.

export const DAY_MS = 24 * 60 * 60 * 1000;

export const EXPIRY_CHOICES = ["7", "30", "90", "180", "custom"] as const;

export type ExpiryChoice = (typeof EXPIRY_CHOICES)[number];

export const EXPIRY_ITEMS: { value: ExpiryChoice; label: string }[] = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "180", label: "180 days" },
  { value: "custom", label: "Custom date" },
];

/** A `datetime-local` value `days` from now, in the browser's time zone. */
export function localDateTimeValue(days: number): string {
  const date = new Date(Date.now() + days * DAY_MS);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

/** Milliseconds from now until a `datetime-local` value, or null if it is not a date. */
export function msUntil(value: string): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time - Date.now();
}

/** The expiry to send: a preset counts from now, a custom date is local time. */
export function expiryToIso(choice: ExpiryChoice, customValue: string): string {
  if (choice === "custom") return new Date(customValue).toISOString();
  return new Date(Date.now() + Number(choice) * DAY_MS).toISOString();
}
