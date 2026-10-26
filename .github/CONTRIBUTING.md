# Contributing to EveryApp

This repository is the platform: the Gateway, the SDK and the CLI. To use EveryApp you don't need it; install the CLI with `npm install -g everyapp` (see the [README](../README.md)). Clone it to change the platform itself.

## Run from a checkout

```bash
git clone https://github.com/every-app/every-app.git
cd every-app
pnpm install
pnpm everyapp setup --domain apps.yourcompany.com
```

`pnpm everyapp` runs the CLI and builds the Gateway from your checkout.

## Build an app against your checkout

```bash
pnpm everyapp create ../my-app
cd ../my-app
pnpm dev
pnpm run deploy
```

An app made from a checkout is linked to that checkout's SDK and CLI, so its `pnpm run deploy` uses your local changes. An app made with the npm `everyapp` is pinned to the published packages instead.

## Before you open a pull request

- `pnpm types:check` and the tests for the packages you touched (`pnpm -C <package> exec vitest run`).
- Docs live in `landing-page/content/docs`; after changing CLI commands or error codes run `pnpm -C packages/cli docs:update`.
- Security problems: report them privately, not in a public issue ([how](../docs/threat-model.md#reporting-a-problem)).

Questions: ask in [Discord](https://discord.gg/c9uGs3cFXr).
