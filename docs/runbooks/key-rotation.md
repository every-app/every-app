# Gateway identity key rotation

Apps receive the gateway identity public key in
`EVERYAPP_IDENTITY_PUBLIC_KEYS` at deploy time. Rotating the gateway's signing
key therefore requires redeploying the gateway and every app.

## Symptoms

After a gateway key rotation, apps that still have the old public key reject
new identity and public-marker JWTs with `401` responses. This is intentional:
identity verification fails closed until the app is redeployed.

## Rotation

1. Inventory every app registered with the gateway and schedule the rotation
   as a maintenance window.
2. Generate a new RSA key pair with
   `node apps/every-app-gateway/regenerate-secrets.js`, which emits the exact
   encodings the runtime requires: a PKCS#8 private key (signing calls
   `importPKCS8`) and an SPKI public key (verification calls `importSPKI`),
   RS256, 2048-bit. Keys in other encodings — an OpenSSH public key or a
   PKCS#1 (`BEGIN RSA PRIVATE KEY`) private key — deploy without error and
   then fail at runtime. Replace both gateway secrets, `JWT_PRIVATE_KEY` and
   the matching `JWT_PUBLIC_KEY`, in one change: in the Cloudflare dashboard,
   **Workers & Pages → every-app-gateway → Settings → Variables and
   Secrets**. Never rotate only one half of the pair.
3. Because the gateway Worker then changed outside everyapp, its next deploy
   asks for confirmation: run `everyapp gateway reconcile --force` in a
   terminal and confirm cf's prompt, so later unattended deploys go through
   again.
4. From each registered app's directory, run
   `everyapp app deploy`. This statically injects the new public key into
   that app.

## Verification

For every app, verify that an authenticated request to a private route and an
anonymous request to a declared public route return their expected success
responses. Also verify that a direct request with a forged
`x-everyapp-identity` header still returns `401`.

Key distribution and coordinated rollout are manual until automated key
distribution is implemented.
