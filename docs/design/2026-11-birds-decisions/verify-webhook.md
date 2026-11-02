# `verifyWebhook()`: assumptions (Agent-assumed, pending Ben's review)

Branch `birds/verify-webhook`, off main at `1f4382df`. The source is §1.6 of `docs/design/2026-11-birds-forcing-function.md` (on `birds-forcing-function`) and its entry in `docs/design/2026-11-birds-decisions/forcing-function.md` (on `birds/decisions-forcing-function`).

Every entry below is **Agent-assumed, pending Ben's review**.

## What landed

- The prototype, cherry-picked unchanged from `fc63740e`: `verifyWebhook()` and `WEBHOOK_MAX_BYTES_DEFAULT` in `@every-app/sdk/server`, its tests, and the `identity.md` and `manifest.md` rows. The cherry-pick applied cleanly; the docs rows needed no drift fix.
- A follow-up commit with the security-review fixes below.

## Assumptions

1. **Defaults kept as the prototype had them:** a 300 s timestamp window (the Gateway's own `EVENT_SIGNATURE_TOLERANCE_SECONDS`) and a 5 MiB body limit. The decisions doc lists both for Ben to look at.
2. **A bad option throws instead of returning a refusal.** A `toleranceSeconds` or `maxBytes` that is NaN, infinite or negative throws a `TypeError`. Without it, a NaN turned the timestamp window off, and a NaN or `Infinity` limit turned the body bound off. Both are the app's programming errors, not the sender's, so a throw (a 500) fails closed and shows up in the logs, the same way an unknown `provider` already threw. `0` stays allowed.
3. **A new refusal reason, `unreadable`.** A body that was already read, or a stream that fails mid-read, now returns `{ ok: false, reason: "unreadable" }`. Before, it threw, which broke the "never throws for a bad delivery" promise.
4. **At most 4 `v1` signatures on an `everyapp` delivery.** The Gateway sends one `v1`, or two while a secret rotates. A header with more is refused as `malformed`, so a sender can't make the app run an HMAC per secret for every one of hundreds of candidates. Slack and GitHub carry one digest each.
5. **Not changed:** the GitHub `deliveryId` is returned and not deduplicated by the helper (the app owns its dedupe store), and a missing `X-GitHub-Delivery` gives `deliveryId: null` and is not refused.

## Security review

- `pnpm security-review` on the cherry-picked branch: 0 findings ($0.17). It reviews code only, so it saw the 3 SDK files.
- A manual pass on constant-time compares, the timestamp window and raw-body handling found the three gaps fixed in assumptions 2–4.
  - Compares: `crypto.subtle.verify` throughout, never `===`.
  - The HMAC runs over the received bytes, prefixed by the provider's signing prefix, with no decode and re-encode.
  - The timestamp is checked before the body is read.
