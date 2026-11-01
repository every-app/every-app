# Harness fixtures

One `sample.jsonl` per harness: the harness's own machine-readable stream for
the same trivial prompt, captured from the installed binary and redacted. The
adapters in `src/harnesses/` are table-driven from these; a test per harness
asserts the normalizer yields the expected counts of each `NormalizedEvent`
kind from its sample (design 4.4). When a harness upgrade changes its stream,
recapture the sample and the fixture test says what moved, instead of a
Sunday run.

The prompt, every time:

```
Print the current directory with pwd, then say DONE
```

Each capture runs in an empty temp directory (`mkdir -p /tmp/fx && cd /tmp/fx`)
so the stream holds no checkout paths. Redact before committing: home paths
(`/Users/<name>` → `/Users/<user>`, the temp dir → `/work`), e-mail
addresses, anything shaped like a key (`sk-…`, `Bearer …`, `est_…`), and in
Claude Code's `init` event the machine's `plugins`, `skills`, `agents`,
`slash_commands`, `mcp_servers`, `memory_paths` and `additional_directories`
(emptied; they are this machine's, not the shape). Session ids, tool-use ids
and model names stay: the adapters key on them. The target is 30–80 lines;
the trivial prompt yields 5–7 lines per harness on 2026-10-23, so the samples
below are shorter than that, and a richer capture (the real setup prompt
against a test account) replaces them once the loop runs.

| Harness     | Version         | Lines | Captured   | Notes                                                                                                                                             |
| ----------- | --------------- | ----- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| claude      | 2.1.309         | 5     | 2026-10-23 | `system init`, `assistant` (tool_use), `user` (tool_result), `assistant` (text), `result`. Captured with the local login; see `--bare` below.     |
| codex       | 0.163.0         | 7     | 2026-10-23 | `thread.started`, `turn.started`, `item.started`/`item.completed` (`agent_message`, `command_execution` with `aggregated_output`), `turn.completed` with `usage`. No timestamps, no USD. |
| opencode    | 2.1.3           | 5     | 2026-10-23 | `step_start`, `tool_use`, `step_finish` (with `cost` and `tokens`), `step_start`, `text`; every line has `timestamp` and `sessionID`. On `opencode/glm-5.3-flash`. |
| cursor      | not installed   | —     | TODO       | Capture inside the image once `CURSOR_API_KEY` exists (below). The adapter is written from the documented shape and labelled provisional.         |
| hermes      | not installed   | —     | TODO       | Capture inside the image once a provider key exists (below). Provisional likewise.                                                                |

## Capture commands

Claude Code (`--bare` needs `ANTHROPIC_API_KEY`; bare mode never reads the
OAuth login, so a machine with only a login drops `--bare`, which is how the
sample here was taken. The loop's own line, `harnesses/claude.ts`, has no
`--bare`: the seeded consent and the key are enough, as `pnpm loop doctor`
checks):

```
claude -p "Print the current directory with pwd, then say DONE" \
  --output-format stream-json --verbose --bare --allowedTools Bash > sample.jsonl
```

Codex CLI (local login or `CODEX_API_KEY`; stdin at EOF, else it says
"Reading additional input from stdin..." on stderr and waits):

```
codex exec --json --skip-git-repo-check \
  "Print the current directory with pwd, then say DONE" < /dev/null > sample.jsonl
```

OpenCode (a stored credential from `opencode auth login`, or
`OPENCODE_API_KEY` for OpenCode Zen; `glm-5.3-flash` is the development
model, never a free tier):

```
opencode run --format json -m opencode/glm-5.3-flash \
  "Print the current directory with pwd, then say DONE" > sample.jsonl
```

Cursor agent CLI (not installed on this Mac; run inside the loop image with
`CURSOR_API_KEY` from the dedicated Cursor account):

```
docker run --rm -e CURSOR_API_KEY -w /work <image> \
  agent -p --force --trust --sandbox disabled --output-format stream-json \
  "Print the current directory with pwd, then say DONE" > sample.jsonl
```

Hermes (not installed on this Mac; run inside the loop image with
`ANTHROPIC_API_KEY`, the setup wizard skipped by `HERMES_HOME` pointing at a
prepared config):

```
docker run --rm -e ANTHROPIC_API_KEY -e HERMES_HOME=/loop/hermes -w /work <image> \
  hermes chat --oneshot --format stream-json --yolo --provider anthropic -m claude-sonnet-5-5 \
  -q "Print the current directory with pwd, then say DONE" > sample.jsonl
```

After any capture: `grep -n "@\|/Users/[a-z]" sample.jsonl` must print nothing
but plugin-source names, and no line may hold a key.
