# B4+B5 Fix Report — pi-subagents

Branch: `fix-b4-b5-aug15` (base 74075e9)

## B4 — steer-on-busy kills child

**Root cause** (`src/runs/shared/subagent-prompt-runtime.ts`, flush() ~line 396):
Explicit `mode:"steer"` requests were delivered with `deliverAs:"steer"` even while the child agent was mid-turn (`inTurn=true`) or awaiting settlement (`awaitingSettlement=true`). Pi core rejects steer delivery in that state with `"Agent is already processing — Specify streamingBehavior"`, which escaped as an unhandled rejection and killed the child. `mode:"auto"` already downgraded correctly; explicit steer did not.

**Fix** (same file, flush() delivery computation):
```ts
const midTurnBusy = inTurn || awaitingSettlement;
const delivery = requestedMode === "follow_up" || (requestedMode !== "follow_up" && midTurnBusy)
    ? "followUp" as const : "steer" as const;
```
Any steer/auto request while mid-turn or awaiting settlement downgrades to `followUp` (queued for the next turn boundary) — matching the existing auto-mode downgrade semantics. Steer between turns (idle) is still allowed.

**TDD:**
- RED `9e89abb` — `test/unit/b4-steer-busy-child.test.ts`: busy steer throws, 0 messages delivered.
- GREEN `945ced9` — fix + test passes; full `subagent-prompt-runtime.test.ts` 45/45.

## B5 — agents requesting unavailable child tools (4x pre-launch failures)

**Root cause** (`src/agents/agents.ts:512` resolveAgentName):
Agent configs (e.g. explore/oracle personas requesting `intercom`) passed resolution unvalidated. The child spawned, the runtime diagnostic (`tool-availability.ts`) detected the unavailable tool only after the process started, and the gate retried 4 consecutive times before surfacing a cryptic pre-launch failure.

**Fix** (same file, new `validateAgentTools` + resolveAgentName integration):
- Bare-name tools must be in the known child-available set:
  - core builtins: `bash, edit, find, grep, ls, read, write`
  - runtime-registered: `contact_supervisor, structured_output, wait, subagent`
  - ambient research tools (declared by builtin researcher agent): `web_search, fetch_content, get_search_content`
- Path-like entries (contain `/` or end `.ts`/`.js`) and `mcp:`-prefixed names always pass (they load extension/adapter code).
- Violations return `{ error: "Agent '<name>' declares unavailable child tools: <tools>. The \`tools\` field is a strict allowlist; ..." }` from resolveAgentName — fail-fast at resolve, before spawn.
- Applied at all four resolve paths (exact-match single/multi, alias single/multi).

**TDD:**
- RED `5729c46` — `test/unit/b5-agent-tool-validation.test.ts`: config with `intercom` resolved without error.
- GREEN `c86789a` — validation added; test 3/3 passes.

## Baseline trap fixed (env isolation, not behavior change)

`test/unit/subagent-prompt-runtime.test.ts` "registers child watchdog lifecycle handlers only when enabled by env" failed with `2 !== 1` when the suite itself ran inside a live pi-subagents child: the live runner exports `SUBAGENT_STEER_INBOX_ENV`, so `registerSteeringInbox` registered an extra `agent_end` handler. Fix: `delete process.env[SUBAGENT_STEER_INBOX_ENV]` in that test's setup (same pattern as the existing `RUNTIME_EXTENSION_ACK_PATH_ENV` cleanup directly above).

## Test evidence

Full unit suite (`node --experimental-strip-types --test "test/unit/*.test.ts"`):

| | tests | pass | fail | cancelled |
|---|---|---|---|---|
| baseline (HEAD before fixes) | 2020 | 1993 | 14 | 10 |
| with B4+B5 | 2020 | 1995 | 12 | 10 |

- Zero regressions; +2 pass (B5 RED test now passes; one baseline fail recovered via the B4 flow fix).
- Remaining 12 fails are pre-existing on baseline (e.g. "prunes repo internals..." package discovery, agent-management 8x, async-status flake) — present in `/tmp/fails-baseline.txt` and unchanged by this branch.

Commits (in order):
1. `9e89abb` test(red): B4 busy steer throws instead of downgrading
2. `945ced9` fix(b4): mid-turn steer downgrades to followUp + watchdog test env isolation
3. `5729c46` test(red): B5 agent config with unavailable tool passes resolve
4. `c86789a` fix(b5): resolveAgentName validates child tool allowlist at resolve time

## Residual risks

- The child-available tool set is a static list; a user extension registering a new bare-name tool (loaded via `extensions`/`subagentOnlyExtensions`) would need its tool names added, or configs using them must reference the provider path-like. The error message states this contract.
- B4 fix downgrades explicit steer to followUp while mid-turn; callers needing hard in-turn injection semantics lose that (pi core cannot accept it anyway — this matches runtime reality).
