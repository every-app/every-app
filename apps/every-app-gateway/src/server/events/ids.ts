/**
 * The event bus's ids (docs/design/2026-10-events-out.md, section 2). An
 * event id is `evt_` and a ULID the gateway makes itself: ten characters
 * of Crockford base32 time, sixteen of randomness, so ids sort by time
 * without a library and a receiver can order what it got. Subscriptions
 * and deliveries get `sub_` and `dlv_` and 24 hex characters, like groups
 * (`grp_`), with the shape checks the server functions' schemas use.
 */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

/** The ULID's time part: `ms` in base32, most significant first. */
function encodeTime(ms: number): string {
  let value = ms;
  let out = "";
  for (let index = 0; index < TIME_CHARS; index += 1) {
    out = CROCKFORD[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = new Uint8Array(RANDOM_CHARS);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += CROCKFORD[byte % 32];
  return out;
}

function hex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** `evt_` + 26 characters that sort by time. */
export function newEventId(now = new Date()): string {
  return `evt_${encodeTime(now.getTime())}${encodeRandom()}`;
}

/** `sub_` + 24 hex. */
export function newSubscriptionId(): string {
  return `sub_${hex(12)}`;
}

/** `dlv_` + 24 hex. */
export function newDeliveryId(): string {
  return `dlv_${hex(12)}`;
}

export const SUBSCRIPTION_ID_PATTERN = /^sub_[0-9a-f]{24}$/;
export const DELIVERY_ID_PATTERN = /^dlv_[0-9a-f]{24}$/;
