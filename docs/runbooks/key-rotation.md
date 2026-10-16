# Gateway identity key rotation

Apps receive the gateway identity public key in
`EVERYAPP_IDENTITY_PUBLIC_KEYS` at deploy time. App deploys read that key
from the gateway's install row (`_everyapp_install.jwt_public_key` in the
gateway's D1), which the CLI writes when it generates the key pair at the
gateway's first deploy; no endpoint serves it. Rotating the gateway's signing
key therefore means replacing the pair on the gateway, recording the new
public key in the install row, and redeploying every app.

## Symptoms

After a gateway key rotation, apps that still have the old public key reject
new identity and public-marker JWTs with `401` responses. This is intentional:
identity verification fails closed until the app is redeployed.

An app deploy that stops with `IDENTITY_KEY_UNKNOWN` is reading an install
row with no public key (a gateway first deployed by an older CLI): do step 3
below with the gateway's current `JWT_PUBLIC_KEY`.

## Rotation

1. Inventory every app registered with the gateway (`everyapp gateway
   status`) and schedule the rotation as a maintenance window.
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
3. Record the new public key in the install row, where app deploys read it.
   Write the request body to a private file (`key.json`, with the PEM's line
   breaks as `\n`):

   ```json
   {
     "sql": "UPDATE _everyapp_install SET jwt_public_key = ?1 WHERE id = 'install'",
     "params": ["-----BEGIN PUBLIC KEY-----\nMIIB…\n-----END PUBLIC KEY-----\n"]
   }
   ```

   then, with the gateway's account selected
   (`npx cf@1.0.0-beta.14 d1 list --name every-app-gateway` gives the
   database id):

   ```sh
   CLOUDFLARE_ACCOUNT_ID=<account id> npx cf@1.0.0-beta.14 d1 query <database id> --body @key.json
   ```

   Delete `key.json` afterwards. Until this step is done, app deploys keep
   handing apps the old key.
4. Because the gateway Worker then changed outside everyapp, its next deploy
   asks for confirmation: run `everyapp gateway reconcile --force` in a
   terminal and confirm cf's prompt, so later unattended deploys go through
   again.
5. From each registered app's directory, run
   `everyapp app deploy`. This statically injects the new public key into
   that app.

## Verification

For every app, verify that an authenticated request to a private route and an
anonymous request to a declared public route return their expected success
responses. Also verify that a direct request with a forged
`x-everyapp-identity` header still returns `401`.

Key distribution and coordinated rollout are manual until automated key
distribution is implemented.
