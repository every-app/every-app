// Main asks the window to show a page: the app menu's Settings… (⌘,) and, later, the tray.
// The payload (NavigateRequest in shared/ipc.ts) comes over IPC, so it's checked before anything
// navigates.

export type NavigateTarget = { to: "/settings" } | { to: "/" } | { to: "/meetings/$id"; params: { id: string } };

export function navigateTarget(request: unknown): NavigateTarget | null {
  if (!request || typeof request !== "object") return null;
  const r = request as Record<string, unknown>;
  if (r.to === "settings") return { to: "/settings" };
  if (r.to === "home") return { to: "/" };
  if (r.to === "meeting" && typeof r.meetingId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(r.meetingId)) {
    return { to: "/meetings/$id", params: { id: r.meetingId } };
  }
  return null;
}
