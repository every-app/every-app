// Adapting what main and /api/v1 send to what the @every-app/desktop-ui screens draw.

import type { AuthSnapshot } from "@shared/ipc";
import type { MeResponse } from "@shared/contract";
import type { Account } from "@every-app/desktop-ui";
import type { CalendarConnection } from "@every-app/desktop-ui";
export { loadable } from "./loadable";
export { comingUpFrom } from "./calendar";


/** "ben@every.to" → "Ben"; the API has no display name. */
export function nameFromEmail(email: string | undefined): string {
  const local = (email ?? "").split("@")[0] ?? "";
  const words = local.split(/[._-]+/).filter(Boolean);
  if (words.length === 0) return "You";
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
}

export function accountFrom(me: MeResponse | undefined, auth: AuthSnapshot | undefined): Account | null {
  const email = me?.user.email ?? auth?.email;
  if (!email) return null;
  return { name: nameFromEmail(email), email, orgName: me?.user.orgName ?? auth?.orgName ?? "Team" };
}

export function calendarConnectionFrom(me: MeResponse): CalendarConnection {
  const c = me.calendar;
  if (!c.available) return { state: "unavailable" };
  if (!c.connected) return { state: "disconnected", reconnect: c.reconnect };
  return { state: "connected", email: me.user.email };
}
