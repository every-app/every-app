# What the CLI prints

The rules for anything `everyapp` prints for a person. A person scans it; they
don't read it. The helpers are in `packages/cli/src/lib/output` (`result.ts`
for a command's result, `events.ts` for how it is drawn).

1. **The first line says what happened**, in a few words, past tense, no
   period: `✓ Removed cloudflare from Acme`. `✗` when it failed. A command that
   had nothing to do still gets `✓`, and says "already".
2. **Then only what the person must know or do next.** One fact per line, as a
   label and a value (`Left behind:` and its rows). If they'd shrug at a line,
   it goes in the detail.
3. **Commands sit on a line of their own**, whole, so they can be copied:
   `Undo:  everyapp mcp on cloudflare`, or under `Clean up:` / `Next:` when
   there are several. Never inside a sentence.
4. **No sentence chains three clauses**, and none explains how the Gateway
   works inside (rows, snapshots, tokens, "within 30 seconds") unless the
   person has to act on it.
5. **The short form is the default; `--verbose` adds the full account** (the
   sentences that used to print always). Nothing is dropped: every fact is in
   the short form, the detail, or `data`.
6. **When detail was held back, the last line is a dim `More: --verbose`.**
   It is the same for a person and for an agent reading plain output: no
   terminal does not mean verbose. Agents pass `--json`, which is unchanged
   and always carries the full account in `message` and `data`. One output per
   command keeps logs, bug reports and tests the same wherever it runs.
7. **Errors: what went wrong, then the one command that fixes it** (`fix` in
   words only when no command does). A refusal says "Nothing changed" at most
   once. An error's text may change, and it is the same text in
   `--json`: its code, `rerun` and `data` are the contract a script reads.
8. **Same words everywhere:** Added / Removed / Turned on / Turned off / Set;
   "the Gateway" (capital G) or its host; secrets are named, never shown.

In code: `finish(out, { headline, blocks, detail, data })` from
`lib/output/result.ts`, with `factLines` and `commandLines` for the blocks. A
step's line is `✓ Built · 4.2s` (`ticked`). The audit this came from, and what
is still to do, is in the pull request that added this page.
