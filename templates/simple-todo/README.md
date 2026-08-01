# Every App

## Development

Run locally behind the local gateway (stub mode, with a seeded dev user):

```sh
pnpm install
pnpm dev
```

Use `pnpm dev:vite` only when you intentionally need the bare Vite server;
SDK-protected routes require the gateway started by `pnpm dev`.

Generate Migration

```sh
pnpm run db:generate
```

Migrate Local DB

```sh
pnpm run db:migrate:local
```

## Deploy

```sh
npx everyapp app deploy
```
