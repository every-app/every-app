# Agent principals (Birds briefs 6–10): assumptions

Written 2026-11-01, built autonomously on stacked `birds/agent-*` branches for Ben to review at the end. Source: §1.3 of `docs/design/2026-11-birds-forcing-function.md` (on `birds-forcing-function`) and briefs 6–10 of `docs/design/2026-11-birds-decisions/forcing-function.md` (on `birds/decisions-forcing-function`).

Every entry below is **Agent-assumed, pending Ben's review**. None of it is in TODO.md's "Decided for Ben".

## Phase 1: the SDK accepts `chan: "agent"` (`birds/agent-channel`)

- **`chan: "agent"` needs an `agent:` actor on the tools endpoint.** The brief says only "accepts `chan` ∈ {mcp, agent}". The SDK also refuses a `chan: "agent"` identity whose `act.sub` isn't `agent:<non-empty id>` (`403 forbidden`, the same answer as any wrong channel). Why: the only minter will be the ToolBus, which always sets that actor, so an agent identity without one is a minting bug, and refusing it keeps `isAgentCall(user)` and the endpoint in agreement. Agent-assumed, pending Ben's review.
- **`isAgentCall(user)` is a boolean, not an id parser.** It is true for `channel === "agent"` with `actor.sub` `agent:<id>`. An app reads the agent's id from `user.actor.sub`. No `agentId(user)` helper yet; add one when an app needs it. Agent-assumed, pending Ben's review.
- **The handler path is unchanged.** `chan: "agent"` is only accepted with a `tc` claim on `/__everyapp/tools/call`; the perimeter never mints `agent` for an app route, and nothing in phase 1 makes it. Agent-assumed, pending Ben's review.
- **Scope rules are identical to `mcp`.** Explicit `mcp:read`/`mcp:write`, `*` never counts, `mcp:destructive` never minted. Agent-assumed, pending Ben's review.
- **Exported constants** `TOOL_CALL_CHANNELS` and `AGENT_ACTOR_PREFIX` from `@every-app/sdk`'s internal protocol module, so the ToolBus (phase 2) mints from the same strings the SDK checks. Agent-assumed, pending Ben's review.
