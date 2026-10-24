# Every App

A private web app on Cloudflare behind your Every App Gateway. The Gateway signs people in; the app gets who they are. It starts as a todo list whose first screen shows who you are and what the app was allowed. Tell your coding agent what it should become: the notes it reads are in `AGENTS.md`.

## Run it

```sh
pnpm dev
```

Open the address it prints. You're signed in as a test user. Ctrl+C stops it.

## Put it online

```sh
pnpm run deploy
```

It prints the app's address and who can open it. Run it again for every change you want live.

## Use it from Claude, ChatGPT or Cursor

Its tools are served by your Gateway at `https://<your gateway>/mcp`: https://everyapp.com/docs/connect-ai
