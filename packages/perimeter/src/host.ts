/**
 * Host-header parsing.
 *
 * The first DNS label is the app id; the remainder is the base host. This is
 * parsed dynamically so the same code serves `todo.example.com`,
 * `todo.localhost:8787`, and portless's per-worktree
 * `todo.fix-ui.everyapp.localhost` — never a hardcoded base host.
 */
export interface ParsedHost {
  /** First label, e.g. `todo`. Empty when the host has no app label. */
  appLabel: string;
  /** Everything after the first label, e.g. `example.com` or `localhost:8787`. */
  baseHost: string;
  /** The full host as received (lowercased, port preserved). */
  host: string;
}

export function parseHost(hostHeader: string | null): ParsedHost | null {
  if (!hostHeader) return null;
  const host = hostHeader.trim().toLowerCase();
  if (host.length === 0) return null;

  const dot = host.indexOf(".");
  if (dot <= 0) {
    // No label separator (e.g. bare `localhost:8787`) — this is the base host
    // itself (the launcher), not an app.
    return { appLabel: "", baseHost: host, host };
  }
  return {
    appLabel: host.slice(0, dot),
    baseHost: host.slice(dot + 1),
    host,
  };
}
