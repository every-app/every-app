# Docker Self-Hosting Runtime

This guide shows how to self-host the Every App gateway with Docker Compose.

It runs the gateway in the local Cloudflare-compatible runtime mode (`wrangler`/Vite dev stack) so bindings and request handling behavior stay close to how Workers run, while still running on your own machine or server.

The gateway compose file is `apps/every-app-gateway/docker-compose.yml`.

> **Chef's standalone Docker self-host is not supported under Every App v2.**
> The old two-container path does not provision Chef's signed identity or
> gateway service binding. Deploy Chef with `npx everyapp app deploy`, or use
> `npx everyapp dev` for local development.

## Prerequisites

- Docker Desktop (or Docker Engine + Docker Compose)

## Runtime model

This Docker workflow intentionally runs the app runtime in local emulation mode.

- Why: this gives better compatibility with Cloudflare bindings than a generic static preview server.
- What this means: you are still self-hosting the containers, but the app process is not a production Cloudflare edge deployment.

## Security responsibilities

You are responsible for network exposure and access control in self-hosted deployments.

- Keep published ports bound to localhost unless you intentionally expose them.
- If exposed publicly, put them behind a hardened reverse proxy, VPN, firewall rules, or Cloudflare Zero Trust.
- Treat `.env` files as sensitive, and do not reuse production secrets for local testing.

## 0) URL strategy

This setup uses one canonical gateway URL across browser and server requests:

- `http://every-app-gateway.localhost:3000`

Why this is used:

- The app verifies JWT issuer against `GATEWAY_URL`.
- The same `GATEWAY_URL` is used by server-side calls to Gateway.
- `.localhost` keeps browser APIs such as `crypto.randomUUID()` available in local development.
- No `/etc/hosts` change is required on the host machine.

This hostname is for local Docker self-hosting only. Cloudflare deployments should use their real gateway URL.

## 1) Run the Gateway

From the repository root:

```bash
cd apps/every-app-gateway
cp .env.example .env
docker compose up --build
```

Gateway URL:

- `http://every-app-gateway.localhost:3000`

### Gateway env vars

Copy `.env.example` to `.env` in `apps/every-app-gateway`, then set values as needed.

Runtime requirements:

- `GATEWAY_URL` is required by Gateway runtime. The compose default is `http://every-app-gateway.localhost:3000`.
- `BETTER_AUTH_SECRET` is required by Gateway runtime.
- `JWT_PRIVATE_KEY` and `JWT_PUBLIC_KEY` are required by Gateway runtime as a matching pair.
- `OPENAI_API_KEY` is required only if you use gateway AI provider proxy routes.

For Docker self-hosting, the entrypoint handles required auth keys this way:

- If `BETTER_AUTH_SECRET` is missing, it is generated once.
- If JWT keys are missing, a new key pair is generated once.
- Generated values are written to `.env`.
- On restart, missing env vars are re-hydrated from `.env`, so keys stay stable across stop/start cycles.

If you want explicit, deterministic values, set them in `.env`.

### Email delivery (optional)

Docker runs the gateway in local Cloudflare emulation. The emulated `EMAIL`
binding writes messages to local `.eml` files; it does not deliver them. To send
real password-reset and invitation emails from Docker, use the Cloudflare Email
Sending REST transport:

1. Onboard the domain used by `EMAIL_FROM` in Cloudflare Email Sending.
2. Create a Cloudflare API token for the account with **Email Sending**
   permission.
3. Set these values in `apps/every-app-gateway/.env`:

```dotenv
EMAIL_REST_API_TOKEN=<cloudflare-api-token>
CLOUDFLARE_ACCOUNT_ID=<cloudflare-account-id>
EMAIL_FROM=noreply@example.com
EMAIL_FROM_NAME=Every App
```

Both `EMAIL_REST_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are required to select
the REST transport. The Docker entrypoint preserves these optional settings in
`.env` across restarts. See `docs/runbooks/email-sending-setup.md` for domain
onboarding and verification details.

## 2) Bootstrap Gateway Admin

Open:

- `http://every-app-gateway.localhost:3000/sign-up`

Create your owner account.

If you want additional users, add them manually from Gateway admin:

- Open `/admin/users`
- Click `Invite User`
- Send/share the generated invite link
