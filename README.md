<div align="center">
  <img src="pi-goal-x.png" alt="pi-goal-x logo" width="560">
</div>

<div align="center">
  <a href="https://pi.dev/packages?type=extension" target="_blank" rel="noopener noreferrer">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/badge-dark.svg">
      <img src="assets/badge-light.svg" alt="TOP 0.3% of Pi coding agent extensions: #7 of 3,216 by downloads · Sep 8, 2026 (best recorded rank)" width="480">
    </picture>
  </a>
</div>

# pi-goal-x

Adds `/goal` functionality to [pi](https://github.com/earendil-works/pi-coding-agent). The agent helps you define a goal and plan, continues working on it automatically, and submits the result to an optional independent completion auditor.

The extension saves goal objectives, tasks, and progress across sessions. You can pause, resume, revise, or switch goals as your work changes.

## Install

```bash
pi install npm:pi-goal-x
```

## Fork: event-driven goal continuation (wilde-sh)

This repository is the **wilde-sh fork** of `tmonk/pi-goal-x` (upstream base
`fe430b2`, npm 0.31.2). It carries two patches that stop idle auto-continue
checkpoints from burning tokens while there is nothing to do. Measured problem
(bootstrap `docs/audits/2026-09-14-harness-support-audit.md` §A): each
checkpoint wake re-sends the full provider context — **~70–120k input tokens
per wake, 25–45M tokens per idle hour** — because `turn_end`/`agent_settled`
re-queued a 0 ms continuation after any turn that touched a work tool.

### Patch 1 — `continuationIdleDelayMs` cooldown

A turn whose progress calls were all **hygiene** (read-only host tools
`read`/`grep`/`find`/`ls`, or goal-record bookkeeping `update_goal`,
`set_goal_tasks`, `update_goal_task`) no longer re-arms an immediate
checkpoint. It waits out `continuationIdleDelayMs` (default **300000 ms = 5
minutes**) before the next continuation can fire. Objective work — `write`,
`edit`, `bash` — keeps the upstream round-trip cadence so productive goals are
not slowed down. `bash` stays in the productive class because a shell command
cannot be classified syntactically; refining read-only shell detection is a
deliberate follow-up.

- Setting: `continuationIdleDelayMs` (project/global layers, `/goal-settings`).
- Env override: `PI_GOAL_CONTINUATION_IDLE_DELAY_MS`.
- `PI_GOAL_CONTINUATION_IDLE_DELAY_MS=0` restores the upstream legacy
  immediate wake.

### Patch 2 — background-run wake (event-driven)

While a background workflow or sub-agent run is live, **any** turn's
continuation is held instead of re-queued: the producer's completion delivery
is the wake. The registry subscribes to both in-process producers over the
`pi.events` bus (verified 2026-09-14):

- `@tintinweb/pi-subagents`: `subagents:created` / `started` / `completed` /
  `failed` (background `Agent` spawns and detached runs).
- `@quintinshaw/pi-dynamic-workflows`: `pi-dynamic-workflows:lifecycle`
  (`started` / `resumed` / `paused` / `completed` / `failed` / `stopped`),
  scoped to the current session id.

Both producers already deliver the completion back into the origin session via
`pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`, so the
completion itself starts the next turn. While the run is live the continuation
timer still arms at `continuationIdleDelayMs` — that timer is the **in-session
deadline**: if a completion event is ever missed, the goal resumes after the
cooldown instead of stalling. User-initiated continuations (session start,
resume, compaction, goal creation) are never background-gated.

If no producer is loaded the registry stays empty and patch 1 alone governs.
A run from **another session** can never hold this session's continuation.

### Fail-safe deadline wake (systemd transient timer)

Per the estate's hard rule, an external deadline should backstop the in-process
timer. The pattern is a transient user timer that fires a wake command after T:

```bash
# Fire /path/to/goal-wake-command once, 30 minutes from now.
systemd-run --user --collect --on-active=30min \
  --timer-property=AccuracySec=30s \
  /path/to/goal-wake-command
# Inspect / cancel:
systemctl --user list-timers --all | grep run-
systemctl --user stop run-<unit-id>.timer
```

**Honesty note (proof obligation).** `systemd-run` only schedules and executes
a command — it does **not** by itself inject a turn into a pi session. The
delivery path (session identity plus a marker-file watcher or the pi-RPC
surface) is not yet verified, so this is an operator-managed deadline, not a
guarantee. Until that path is proven, treat an armed-but-eventless wait as
bounded by the in-session `continuationIdleDelayMs` timer only, and see
bootstrap audit §B options 2/3 for the unverified delivery designs.

Headless-origin caveat: a headless pi parent that exits at end of turn leaves
background fan-out with no origin session to receive `sendCustomMessage`, so
event-driven wake cannot apply there. Headless runs should bind `background:
false` / wait in-turn (as the estate's delegate-task dispatcher already
requires); a persistent-origin pattern for headless goals remains an open
follow-up.

### Installing the fork

The persistent install is pinned to a **validated merge commit** (never a
mutable branch):

```bash
pi install git:github.com/wilde-sh/pi-goal-x@<merge-sha>
```

For a temporary trial of a branch during validation, use `pi -e` (current run
only):

```bash
pi -e git:github.com/wilde-sh/pi-goal-x@fix/continuation-idle-delay
```

## Create a goal

```text
/goal Add CSV export to the reports page, with documentation and tests.
```

The agent discusses the goal with you, asks focused questions where needed, and proposes an objective, task plan, and completion requirements. You review the proposal and choose whether to use the completion auditor. Once you confirm, the agent starts working and continues automatically while the goal is active.

You can specify completion requirements, such as passing the test suite or producing a report with every required section. The agent tracks tasks and subtasks, records evidence, and works toward those requirements. If it gets blocked and needs your input, you can resolve the issue and resume.

If you already have a complete objective, use `/goal-direct <objective>` to create the goal and start immediately without drafting.

## Goal types

| Type | Behaviour | Example uses |
| --- | --- | --- |
| **Regular** — `/goal` | An outcome to achieve, with the agent choosing and adapting the plan. | Features, debugging, research, and documentation. |
| **Sisyphus** — `/sisyphus` | An ordered plan that the agent follows one step at a time. | Migrations, staged refactors, and release procedures. |

For an ordered goal, you can provide the steps or define them with the agent:

```text
/sisyphus Migrate authentication in this order:
1. Add the new token validator.
2. Update login and session refresh to use it.
3. Remove the old validator.
4. Run the authentication tests.
```

Use `/sisyphus-direct <objective>` to start an ordered goal without drafting.

## Tasks and subtasks

The agent can divide a goal into tasks and subtasks, each describing part of the work required to complete it. During guided goal creation, you review the proposed plan before work begins.

For example, a CSV export goal could have this task plan:

```text
Add CSV export to reports
├─ Review the report data and active filters
├─ Implement CSV export
│  ├─ Generate the CSV from filtered results
│  └─ Add a download button
├─ Test the export
└─ Document how to use it
```

As work progresses, the agent marks the current task, records completed work, and explains any skipped tasks. The dashboard shows what is done and what remains, including progress within subtasks. Task progress is saved when you pause and remains available in later sessions.

Tasks can also have their own completion requirements—for example, “The download contains only rows matching the active filters.” The agent records evidence against those requirements, and the completion auditor uses that evidence when reviewing the overall result.

Use `/goal-tweak <change>` to discuss revisions to the goal and its plan. Task tracking, completion requirements, and subtask depth are configurable in `/goal-settings`.

## Completion auditor

When enabled, a separate agent reviews the work before the goal is accepted as complete. It checks the objective, tasks, recorded evidence, completion requirements, and workspace.

If the auditor approves, the goal is archived as complete. If it identifies unmet requirements, the goal remains open with feedback describing the work still needed. You can choose the auditor model in `/goal-settings` and toggle auditing for the focused goal with `Ctrl+Shift+A`.

## Progress and goal controls

The dashboard above the editor shows the goal's status, task progress, current task, elapsed time, and token usage. Press `Ctrl+Shift+T` to expand it for the full task tree, completion requirements, evidence, and recent activity. Audit progress and results appear there too.

A project can have several open goals, with one focused goal per session. Switch with `/goal-focus`, pause with `/goal-pause`, or use `/goal-tweak` to discuss changes to the current goal. Pressing `Esc` during active work also pauses the goal; in the expanded dashboard, it collapses the view.

## Commands

| Command | What it does |
| --- | --- |
| `/goal [idea]` | Discuss, plan, and confirm a regular goal. |
| `/sisyphus [idea]` | Discuss, plan, and confirm an ordered goal. |
| `/goal-direct <objective>` | Create and start a regular goal immediately. |
| `/sisyphus-direct <objective>` | Create and start an ordered goal immediately. |
| `/goal-list` | List open goals. |
| `/goal-status` | Show the focused goal and its progress. |
| `/goal-focus` | Choose an open goal to work on. |
| `/goal-unfocus` | Leave the current goal open without focusing on it. |
| `/goal-tweak <change>` | Revise the current goal with the agent. |
| `/goal-pause` | Pause work on the focused goal. |
| `/goal-resume` | Resume a paused or blocked goal. |
| `/goal-clear` | Archive the focused goal after confirmation. |
| `/goal-cancel` | Cancel an unconfirmed draft. |
| `/goal-settings` | Configure goal behaviour and the auditor. |

For troubleshooting, use `/goal-status verbose` for more detail, `/goal-status health` or `/goal-recovery` to check for problems, and `/goal-refresh` to reload saved goals and settings after external changes. `/goal-recovery repair` offers repairs after confirmation.

## Settings

Open `/goal-settings` to change these options. You can save defaults for all projects, override them for the current project, or remove an override to use the inherited value.

| Setting | What it controls |
| --- | --- |
| Task tracking (`disableTasks`) | Turn task lists on or off. Set to `true` to disable them. |
| Subtask depth (`subtaskDepth`) | Limit how many levels of subtasks the agent can create. |
| Completion requirements (`disableContracts`) | Turn explicit goal and task completion requirements on or off. Set to `true` to disable them. |
| Auditor disabled | Turn off independent completion review. |
| Auditor provider, model, and thinking level | Choose which model reviews completed work and its reasoning effort. |
| Continuation idle delay (`continuationIdleDelayMs`) | Fork patch 1: cooldown in ms before a no-progress (or background-awaited) continuation re-queues. `0` restores the upstream immediate wake. Env: `PI_GOAL_CONTINUATION_IDLE_DELAY_MS`. |


## License

MIT
