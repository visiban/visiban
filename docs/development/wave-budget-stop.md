# The /wave budget stop

`/wave` gives every agent a budget in its brief (80 tool calls and 45 minutes for an
implementer, expanded once by half to 120). Until #2564 nothing stopped an implementer that ran
past it: it was a `general-purpose` agent, and a built-in has no definition file to carry a
limit. #2564 ported Blueprint's two bounds (macrodream/blueprint#344 and macrodream/blueprint#352).
This page records what each one does, what a live probe showed and what stays unknown. The
operating steps are in `.claude/skills/wave/SKILL.md` (*Per-agent budget*, *Handoff at a stop*).

## Bound 1: a turn ceiling per run (`maxTurns: 121`)

`/wave` spawns its implementers as `wave-harness-worker` (`.claude/agents/wave-harness-worker.md`):
Step 4's implementers, a handoff's fresh agent, a fresh fix-round agent and a Fable rescue.

- **Why a project agent.** `maxTurns` is set only in an agent's definition file. The Agent
  tool has no max-turns parameter, and `general-purpose` is a built-in with no file. With
  `tools:` omitted, a project agent inherits every tool available to subagents, which is what
  `general-purpose` has, so the move changes no tool access.
  <!-- cc-claim: https://code.claude.com/docs/en/sub-agents checked: 2026-11-02 -->
- **The value.** The expanded budget is 120, so a run stopped at 121 has passed it. The extra
  turn buys a final report only for an agent that has stopped calling tools. An agent still
  calling tools gets none.
- **Per run, not per agent.** A resume restarts the count, so strike one's resume reaches a
  ceiling of 80 + 121, and each fix-round resume gets another 121.
- **Turns, not tool calls.** A turn can batch several tool calls, so an agent that batches can
  pass 120 tool calls before the ceiling.
  <!-- cc-claim: https://code.claude.com/docs/en/agent-sdk/agent-loop checked: 2026-11-02 -->

A `maxTurns` stop arrives with status `completed`, no final report, and only a NOTE that the agent
stopped at its turn limit, inviting the orchestrator to send it a message. `/wave` reads every
implementer result for that NOTE and hands off to a fresh agent instead of taking the invitation.
The worktree and its uncommitted files stay on disk (one probe, Claude Code 2.1.316,
2026-11-02; a stop inside a long-running tool call is untested).

## Bound 2: a lifetime total in tool calls (the hook)

`.claude/hooks/pre-tool-agent-budget.sh` runs on `PreToolUse` with matcher `*`. It counts every
tool call a `wave-harness-worker` makes, keyed by `agent_id`, which a resume keeps. On the call
past the limit it emits `continue: false` with `permissionDecision: "deny"`, so that call is
blocked and the agent stops.

- **The limit.** 120 tool calls, the implementer's 80 expanded by half. `WAVE_AGENT_TOOL_CAP`
  overrides it with a positive integer; any other value falls back to 120.
- **Which agents.** Implementers only. The hook's list also names Blueprint's pinned
  `wave-worker`, a type this repo does not have; the name is kept so the hook stays the canonical
  file. `completeness-check` and the read-only gates keep their per-run `maxTurns`. Main-thread
  calls (no `agent_id`) and every other agent type pass untouched.
- **One total per agent.** An implementer that used 100 calls has 20 left for a fix round. A
  fresh agent (a handoff, or a fresh fix-round agent) has a new `agent_id` and so a new count.
  That is intended: it starts from a short brief, not from the stopped agent's context.
- **Where the count lives.** `wave-agent-budget/` in the git common dir, shared by every
  `scripts/wt` worktree, one `<agent_id>.count` per agent. It is resolved from
  `CLAUDE_PROJECT_DIR`, and from the event's `cwd` only when that is unset or not a repository, so
  an agent cannot move its count by moving its working directory. Count and marker files older
  than 30 days are removed on each write.
- **How the orchestrator learns of a stop.** The parent sees a hook stop as a normal finish, with
  no NOTE. So the hook writes `<agent_id>.stopped` once (JSON: `agent_id`, `agent_type`, `count`,
  `limit`, `stopped_at` in UTC), and `/wave` runs
  `python3 scripts/wave-agent-budget.py --stopped <agent_id>` after every implementer result
  (exit 0 stopped, printing the marker's parsed fields; 1 not stopped; 2 usage error or no
  repository). `--count <agent_id>` prints the count so far, which `/wave` reads before resuming an
  implementer for a fix round.
- **Fails closed.** A worker event it cannot read, key (an `agent_id` outside `[A-Za-z0-9_-]`) or
  count is denied with the reason, and so is a count lock held past 4 seconds, which would
  otherwise run into the 10-second hook timeout and let the call through. Limitation (follow-up
  #2650): this does not cover a broken `python3` (one that exits 1 makes the hook exit 1, which
  does not block the call), and with no `python3` the hook can over-block, refusing any event its
  shell pre-filter matches, including main-thread and other-agent calls.

What a probe showed (Claude Code 2.1.318, 2026-11-04, headless runs with a throwaway agent and
hook, recorded on macrodream/blueprint#352): every subagent tool call carries `agent_id` and
`agent_type`, and main-thread calls carry neither; `agent_id` is stable across a resume;
`continue: false` stops the subagent only, and the main thread goes on; `continue: false` alone
lets the crossing call run, and adding the deny blocks it; the parent sees status `completed`
with none of the hook's `stopReason`; `SubagentStop` did not fire after a hook stop.
<!-- cc-claim: https://code.claude.com/docs/en/hooks checked: 2026-11-04 -->

**Accepted risk.** The store sits where an implementer with Bash can write, so an agent can
delete its own count on purpose. The hook still runs before every call, so that is deliberate
sabotage rather than a way around it, and a stopped agent's marker stays for the orchestrator,
whose reader follows no symlink and prints only the marker's parsed fields. The store is shared,
so the same agent could also reset a sibling implementer's count, plant a sibling's marker (a
false handoff) or hold the lock (which denies every worker): still deliberate sabotage, but with
a reach past its own count. The count covers the
implementer's own calls only: the gate agents it spawns have their own `agent_id` and type.

**Untested live.** The hook has not run inside Claude Code in this repo; the probe used a
throwaway script. The `agent_id` shape it accepts rests on the IDs that probe recorded (17
lowercase hex characters after an `a`). An implementer whose first call is denied with the
malformed-ID reason means the pattern is wrong. A crossing inside a batched turn, an interactive
session, and a resume after restarting Claude Code are untested.

## Tests

`scripts/tests/pre-tool-agent-budget.test.sh` (CI job `script-tests`) calls the hook directly with
synthetic events: the main thread and other agent types untouched, the count persisting and the
crossing call denied with the agent stopped, the marker written once, the env override and its
fallback, malformed IDs and unreadable events failing closed, symlinks not followed, a held lock
answered within 8 seconds, 20 concurrent calls losing no count, the 30-day cleanup, the reader's
exit codes, and the `settings.json` registration (exactly one `*` entry) and the `/wave`
marker read. It does not run Claude Code, so what the harness does with the hook's output rests
on the probe above.
