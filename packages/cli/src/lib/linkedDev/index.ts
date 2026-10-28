/**
 * Linked dev's client side (docs/design/linked-dev.md): sign `everyapp
 * dev` in to a Gateway for one app, keep the token fresh, say who it is,
 * and forget it. The token never reaches the app's Worker: the gateway-lite
 * holds it and forwards the SDK's calls (commands/dev/linked.ts).
 */
import os from "node:os";
import { errorMessage, EveryAppError } from "@/lib/errors";
import type { EventSink } from "@/lib/output/events";
import { openInBrowser } from "@/lib/gateway/setup-link";
import { CLI } from "@/lib/output/command";
import { canPromptInTerminal } from "@/lib/output/prompt";
import {
  authorize,
  discover,
  linkedDevResource,
  refresh,
  registerClient,
  revoke,
  type ServerMetadata,
  type Tokens,
} from "./oauth";
import { openLinkedDevStore, type LinkedDevEntry, type LinkedDevStore } from "./store";

/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 60_000;
const STEP = "dev.link";

/** What `GET /linked-dev/<app>/whoami` answers. */
export interface LinkedWhoami {
  user: { id: string; email: string };
  organization: { id: string; name: string };
  role: "owner" | "admin" | "member";
  app: { id: string; rowId: string; name: string; hostname: string | null };
  connection: { id: string; clientName: string };
  hasAccess: boolean;
  limits: { perMinute: number; perDay: number };
}

export interface LinkedSession {
  readonly gateway: string;
  readonly appId: string;
  /** A current access token, refreshed when within a minute of expiry. */
  token(): Promise<string>;
  /** Drop the access token so the next `token()` refreshes (after a 401). */
  invalidate(): void;
  whoami(): Promise<LinkedWhoami>;
  /** The route the forwarder sends to: `${gateway}/linked-dev/<app>`. */
  readonly routeUrl: string;
}

interface LinkOptions {
  gateway: string;
  appId: string;
  out: EventSink;
  /** Tests: the store, fetch, and the browser. */
  store?: LinkedDevStore;
  fetchImpl?: typeof fetch;
  openBrowser?: (url: string) => Promise<void>;
  /** Under --json (an agent reads the events) the browser isn't opened: the URL is in the `dev.link` progress event for the agent to hand on. */
  json?: boolean;
  /** Sign in again even with a stored token. */
  fresh?: boolean;
  clientName?: string;
}

/**
 * The Gateway's origin: `--gateway` as a URL, trailing path dropped. https,
 * or http on this machine only: a token and the app's request bodies never
 * cross the network in the clear.
 */
export function gatewayOrigin(gateway: string): string {
  let url: URL;
  try {
    url = new URL(gateway);
  } catch {
    throw new EveryAppError(
      "INVALID_GATEWAY_URL",
      `--gateway must be a full URL, not "${gateway}"\nFor example https://apps.example.com.`,
    );
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackGateway(gateway))) {
    throw new EveryAppError(
      "INVALID_GATEWAY_URL",
      `--gateway must be https (http only on this machine: localhost or 127.0.0.1), not "${gateway}"\nLinked dev sends a token and the app's requests there.`,
    );
  }
  return url.origin;
}

/** Whether a Gateway URL is this machine: linked dev on a local Gateway is allowed (http on loopback). */
export function isLoopbackGateway(gateway: string): boolean {
  try {
    const { hostname } = new URL(gateway);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function entryFrom(
  gateway: string,
  appId: string,
  clientId: string,
  tokens: Tokens,
  previous?: Partial<LinkedDevEntry>,
): LinkedDevEntry {
  return {
    gateway,
    appId,
    clientId,
    refreshToken: tokens.refreshToken || previous?.refreshToken || "",
    accessToken: tokens.accessToken,
    expiresAt: new Date(Date.now() + tokens.expiresIn * 1000).toISOString(),
    ...(previous?.email ? { email: previous.email } : {}),
    ...(previous?.organization ? { organization: previous.organization } : {}),
    linkedAt: previous?.linkedAt ?? new Date().toISOString(),
  };
}

/**
 * The session for `gateway` and `appId`: the stored token when there is
 * one (refreshed when stale), else the browser sign-in (step `dev.link`).
 */
export async function linkGateway(options: LinkOptions): Promise<LinkedSession> {
  const gateway = gatewayOrigin(options.gateway);
  const { appId, out } = options;
  const store = options.store ?? openLinkedDevStore();
  const fetchImpl = options.fetchImpl ?? fetch;
  const resource = linkedDevResource(gateway, appId);
  let metadata: ServerMetadata | undefined;
  const serverMetadata = async () => (metadata ??= await discover(gateway, fetchImpl));

  let entry = options.fresh ? null : store.get(gateway, appId);
  if (!entry) {
    const meta = await serverMetadata();
    const clientId =
      store.list().find((candidate) => candidate.gateway === gateway)?.clientId ??
      (await registerClient(meta, options.clientName ?? `${CLI} dev on ${os.hostname()}`, fetchImpl));
    out.emit({
      type: "step",
      step: STEP,
      status: "start",
      message: `Signing in to ${gateway} for ${appId}: approve everyapp dev in the browser...`,
      data: { gateway, appId },
    });
    const openBrowser =
      options.openBrowser ??
      (canPromptInTerminal(options.json ?? false) ? openInBrowser : async () => undefined);
    const tokens = await authorize({
      metadata: meta,
      clientId,
      resource,
      openBrowser,
      onUrl: (url) =>
        out.emit({
          type: "progress",
          step: STEP,
          message: `If the browser didn't open, visit\n  ${url}`,
          data: { url },
        }),
      fetchImpl,
    });
    entry = entryFrom(gateway, appId, clientId, tokens);
    store.put(entry);
  }

  const session: LinkedSession = {
    gateway,
    appId,
    routeUrl: resource,
    async token() {
      if (Date.parse(entry!.expiresAt) - Date.now() > REFRESH_MARGIN_MS) {
        return entry!.accessToken;
      }
      const meta = await serverMetadata();
      let tokens: Tokens;
      try {
        tokens = await refresh(meta, entry!.clientId, entry!.refreshToken, resource, fetchImpl);
      } catch (error) {
        // The grant is gone: forget it, so the next run signs in again.
        store.remove(gateway, appId);
        throw error;
      }
      entry = entryFrom(gateway, appId, entry!.clientId, tokens, entry!);
      store.put(entry);
      return entry.accessToken;
    },
    invalidate() {
      entry = { ...entry!, expiresAt: new Date(0).toISOString() };
    },
    async whoami() {
      const response = await fetchImpl(`${resource}/whoami`, {
        headers: { authorization: `Bearer ${await session.token()}`, accept: "application/json" },
      });
      if (response.status === 401) {
        store.remove(gateway, appId);
        throw new EveryAppError(
          "LINKED_DEV_REFUSED",
          `${gateway} no longer takes everyapp dev's token for ${appId}: it was revoked, you're no longer an owner or admin, or linked dev was turned off\nRun ${CLI} dev --gateway ${gateway} again to sign in.`,
          { data: { gateway, appId, status: 401 } },
        );
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        throw new EveryAppError(
          "LINKED_DEV_REFUSED",
          `${gateway} refused linked dev for ${appId} (${response.status} ${String(body["error"] ?? "")})\n${String(body["message"] ?? "")}`.trim(),
          { data: { gateway, appId, status: response.status, error: body["error"] } },
        );
      }
      const who = (await response.json()) as LinkedWhoami;
      if (entry && (entry.email !== who.user.email || entry.organization !== who.organization.name)) {
        entry = { ...entry, email: who.user.email, organization: who.organization.name };
        store.put(entry);
      }
      return who;
    },
  };
  return session;
}

interface UnlinkOptions {
  gateway: string;
  appId: string;
  out: EventSink;
  store?: LinkedDevStore;
  fetchImpl?: typeof fetch;
}

/** Revoke the grant at the Gateway (best effort) and forget the token. */
export async function unlinkGateway(options: UnlinkOptions): Promise<LinkedDevEntry | null> {
  const gateway = gatewayOrigin(options.gateway);
  const store = options.store ?? openLinkedDevStore();
  const entry = store.remove(gateway, options.appId);
  if (!entry) return null;
  let revoked = false;
  try {
    const metadata = await discover(gateway, options.fetchImpl ?? fetch);
    revoked = await revoke(metadata, entry.clientId, entry.refreshToken, options.fetchImpl ?? fetch);
  } catch (error) {
    options.out.emit({
      type: "warning",
      code: "LINKED_DEV_REVOKE_FAILED",
      message: `Forgot the token, but couldn't tell ${gateway} to revoke it: ${errorMessage(error)}\nRevoke it under Settings → Connections there.`,
      data: { gateway, appId: options.appId },
    });
  }
  options.out.emit({
    type: "step",
    step: "dev.unlink",
    status: "ok",
    message: revoked
      ? `Signed everyapp dev out of ${gateway} for ${options.appId}.`
      : `Forgot everyapp dev's token for ${options.appId} on ${gateway}.`,
    data: { gateway, appId: options.appId, revoked },
  });
  return entry;
}
