# Docker Self-Hosting Runtime

This guide shows how to self-host Every App with Docker Compose.

It runs each app in the local Cloudflare-compatible runtime mode (`wrangler`/Vite dev stack) so bindings and request handling behavior stay close to how Workers run, while still running on your own machine or server.

Each app has its own `docker-compose.yml` so deployments stay decoupled:
- Gateway: `apps/every-app-gateway/docker-compose.yml`
- Chef app: `apps/chef/docker-compose.yml`

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

## 2) Bootstrap Gateway Admin

Open:

- `http://every-app-gateway.localhost:3000/sign-up`

Create your owner account.

If you want additional users, add them manually from Gateway admin:

- Open `/admin/users`
- Click `Invite User`
- Send/share the generated invite link

## 3) Register the Chef app in Gateway

In the Gateway admin UI (`/admin/apps`), add an app with:

- `App ID`: `chef`
- `App URL`: `http://localhost:3001`
- `Dev URL`: `http://localhost:3001`

Recommended access settings in the Add App modal:

- `Auto-grant to new users`: enabled (new users automatically get access)
- `Grant to all existing users`: enabled (existing users get access immediately)

If you need to adjust access later, use `Manage Access` from the app row in `/admin/apps`.

Then create an app token in `/admin/tokens` for that app with scope:

- `provider:openai`

Copy the generated token.

## 4) Run the Chef app

In a second terminal:

```bash
cd apps/chef
cp .env.example .env
# Put the token in .env as GATEWAY_APP_API_TOKEN
docker compose up --build
```

Chef URL:

- `http://localhost:3001`

### Chef env vars

Runtime requirements:

- `GATEWAY_URL` (default: `http://every-app-gateway.localhost:3000`)
- `VITE_GATEWAY_URL` (default: `http://every-app-gateway.localhost:3000`)
- `VITE_APP_ID` (default: `chef`)
- `GATEWAY_APP_API_TOKEN` (required for gateway-authenticated provider proxy calls in this app)

`GATEWAY_URL` is the canonical gateway URL used for token issuer checks and server-side gateway requests.

The container writes these into `.env` and runs local migrations automatically.

Security note:

- Entrypoints write runtime values (including auth secrets and app tokens) to `.env` inside each app directory.
- `.env` is gitignored, but treat it as sensitive material.
- Do not expose these containers directly to the public Internet unless you apply proper network controls.

## Manual multi-host setup (different VPS machines)

This workflow also works when Gateway and app run on different hosts (for example, separate Hetzner VPS instances).

Minimum manual setup:

- Deploy Gateway and make it reachable at a public URL (for example `https://gateway.example.com`).
- Deploy app and make it reachable at a public URL (for example `https://chef.example.com`).
- In Gateway `/admin/apps`, add the app with:
  - `App ID`: `chef`
  - `App URL`: `https://chef.example.com`
  - `Dev URL`: optional (only if you want a separate dev origin)
- In app environment, set:
  - `GATEWAY_URL=https://gateway.example.com`
  - `VITE_GATEWAY_URL=https://gateway.example.com`
  - `VITE_APP_ID=chef`
  - `GATEWAY_APP_API_TOKEN=<token generated in /admin/tokens>`

Notes:

- This is intentionally manual for now (no CLI automation in this Docker workflow).
- If app access is not granted automatically, manage it manually in Gateway admin (`/admin/apps` -> `Manage Access`).

## Notes

- Gateway and apps are intentionally independent. You can run as many apps as you want, each with its own compose project.
- The Chef app talks to Gateway using `GATEWAY_URL` on the server side and `VITE_GATEWAY_URL` on the client side.
- Chef compose adds an `extra_hosts` mapping so `every-app-gateway.localhost` resolves inside the container.
