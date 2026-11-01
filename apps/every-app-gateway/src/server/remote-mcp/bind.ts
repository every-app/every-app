/**
 * A remote MCP app's credential, and where it may go
 * (docs/design/2026-10-mcp-by-url.md, "The credential and where it is
 * pinned"). The value is a Gateway setting named by the row's manifest
 * (`<ID>_MCP_TOKEN`), read from this Worker's env and never from anywhere
 * else. A name is bound to one origin: the one `everyapp secret set`
 * recorded (the operator's explicit pin). A value set some other way (the
 * Cloudflare dashboard) has no pin and is sent nowhere until the operator
 * runs `secret set`: the gateway never pins on first use, since the first
 * row to use a name could be any owner's or admin's. The gateway sends the
 * credential only to the origin it is bound to: a row whose URL names
 * another origin reads as needing setup, and nothing is sent.
 *
 * Nothing here returns the value except as the request headers the client
 * sends, and nothing logs it.
 */
import { env } from "cloudflare:workers";
import { logEvent } from "@every-app/perimeter";
import {
  remoteMcpAuthHeaders,
  remoteMcpSecretOf,
  remoteMcpUrlProblem,
  type RemoteMcpBlock,
} from "@every-app/sdk/internal";
import { RemoteMcpRepository } from "@/server/repositories/RemoteMcpRepository";

export type CredentialState =
  /** `auth.kind: none`: nothing to send. */
  | { kind: "none"; headers: Record<string, string> }
  /** The credential is set and bound to this row's origin. `secrets`: every form of the value an error must never show. */
  | {
      kind: "ready";
      headers: Record<string, string>;
      name: string;
      secrets: string[];
    }
  /** The Gateway setting isn't set. */
  | { kind: "unset"; name: string }
  /** The setting is set, but no operator pinned it to an origin: nothing is sent. */
  | { kind: "unpinned"; name: string }
  /** The setting is set, but for another origin: nothing is sent. */
  | { kind: "mismatch"; name: string; boundOrigin: string }
  /** `auth.kind: oauth`: not served this week. */
  | { kind: "unsupported"; reason: string }
  /** The row's URL is refused by the rules: nothing is sent or bound. */
  | { kind: "refused"; reason: string };

/** How long a binding read stays good in this isolate. */
const BINDING_CACHE_MS = 60_000;
const bindings = new Map<string, { origin: string; readAt: number }>();

export function resetRemoteMcpBindingsForTests(): void {
  bindings.clear();
}

function settings(): Record<string, unknown> {
  return env as unknown as Record<string, unknown>;
}

/** The setting's value when set to something, else null. */
function settingValue(name: string): string | null {
  const value = settings()[name];
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * The origin a credential name is pinned to, or null when no operator has
 * pinned it (`everyapp secret set` writes the pin). Never written here. A
 * pin is cached per isolate for a minute; its absence is not, so a pin
 * written by the CLI is seen on the next read.
 */
async function boundOrigin(name: string): Promise<string | null> {
  const cached = bindings.get(name);
  const now = Date.now();
  if (cached && now - cached.readAt < BINDING_CACHE_MS) return cached.origin;
  const existing = await RemoteMcpRepository.findCredentialBinding(name);
  if (!existing) return null;
  bindings.set(name, { origin: existing.origin, readAt: now });
  return existing.origin;
}

/**
 * The credential state for a row's `remote` block: the headers to send,
 * or why nothing can be sent. Reads the Gateway's env and the binding
 * table, writes nothing; logs a missing pin or a mismatch once per read.
 */
export async function credentialFor(
  block: RemoteMcpBlock,
  rowId: string,
): Promise<CredentialState> {
  // The URL rule first, so a row edited by hand never binds a credential
  // to an address the rules refuse.
  const read = (name: string) => {
    const value = settings()[name];
    return typeof value === "string" ? value : null;
  };
  const urlProblem = remoteMcpUrlProblem(block.url, {
    gatewayUrl: read("GATEWAY_URL") ?? "",
    appBaseDomain: read("APP_BASE_DOMAIN"),
    thirdPartyDomain: read("THIRD_PARTY_DOMAIN"),
  });
  if (urlProblem) {
    return {
      kind: "refused",
      reason: `its address is refused by this Gateway (${urlProblem})`,
    };
  }
  if (block.auth.kind === "oauth") {
    return {
      kind: "unsupported",
      reason:
        "this server wants OAuth, which this Gateway doesn't do yet; if it also takes an API key, add it again with --auth bearer",
    };
  }
  const name = remoteMcpSecretOf(block.auth);
  if (!name) return { kind: "none", headers: {} };
  const value = settingValue(name);
  if (!value) return { kind: "unset", name };
  const origin = new URL(block.url).origin;
  const bound = await boundOrigin(name);
  if (bound === null) {
    logEvent(
      "mcp.remote.credential_unpinned",
      { name, appRowId: rowId, origin },
      "warn",
    );
    return { kind: "unpinned", name };
  }
  if (bound !== origin) {
    logEvent(
      "mcp.remote.credential_origin_mismatch",
      { name, appRowId: rowId, origin, boundOrigin: bound },
      "warn",
    );
    return { kind: "mismatch", name, boundOrigin: bound };
  }
  // The raw value, and for a user:password pair each half, so the client's
  // sanitizer strips them from anything an error carries.
  const secrets = [value];
  if (block.auth.kind === "basic" && value.includes(":")) {
    const colon = value.indexOf(":");
    secrets.push(value.slice(0, colon), value.slice(colon + 1));
  }
  return {
    kind: "ready",
    headers: remoteMcpAuthHeaders(block.auth, value),
    name,
    secrets: secrets.filter((part) => part.length > 0),
  };
}

/** Plain words for a state that serves nothing, for setup reports and tool errors. */
export function credentialProblem(
  state: CredentialState,
  cli = "pnpm everyapp",
): string | null {
  switch (state.kind) {
    case "none":
    case "ready":
      return null;
    case "unset":
      return `its credential ${state.name} isn't set on this Gateway: its operator sets it with ${cli} secret set ${state.name}`;
    case "unpinned":
      return `its credential ${state.name} is set but not pinned to a server: its operator runs ${cli} secret set ${state.name}, which pins it to this server`;
    case "mismatch":
      return `its credential ${state.name} was set for ${state.boundOrigin}, not for this server; its operator runs ${cli} secret set ${state.name} again`;
    case "unsupported":
    case "refused":
      return state.reason;
  }
}
