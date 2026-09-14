/**
 * Stage 0 golden tests: the continuation checkpoint contract.
 *
 * Pins how the extension treats queued/injected continuation checkpoints
 * today (specs/2026-08-03-codex-inspired-goal-interface Stage 0):
 *
 *   1. A checkpoint for a goal that is no longer the focused active goal is
 *      stale: the turn is aborted and `[GOAL STALE goalId=...]` guidance is
 *      injected instead of doing goal work.
 *   2. A checkpoint that matches the focused active goal proceeds normally.
 *   3. A user-driven turn cancels any pending continuation, so a queued
 *      checkpoint is never delivered after the user takes over.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import piGoalExtension from "../extensions/goal.ts";
import {
	createGoal,
	goalFocusDetails,
	type GoalRecord,
	type GoalStateEntry,
} from "../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../extensions/storage/goal-files.ts";

const FIXTURE_GOAL = readFileSync(new URL("./fixtures/goals/active_goal_fixture.md", import.meta.url), "utf8");

// ── Harness ──────────────────────────────────────────────────────────────────

interface HandlerMap {
	[key: string]: (event: any, ctx: ExtensionContext) => Promise<unknown> | unknown;
}

function createHarness(cwd: string) {
	const handlers: HandlerMap = {};
	const sentMessages: Array<{ customType?: string; details?: unknown }> = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	// Fork patch 2: in-process event bus double so tests can emit producer
	// lifecycle events (pi-subagents / pi-dynamic-workflows channels).
	const busHandlers = new Map<string, Set<(data: unknown) => void>>();
	const events = {
		on: (channel: string, handler: (data: unknown) => void) => {
			const set = busHandlers.get(channel) ?? new Set<(data: unknown) => void>();
			set.add(handler);
			busHandlers.set(channel, set);
			return () => { set.delete(handler); };
		},
		emit: (channel: string, data: unknown) => {
			for (const handler of busHandlers.get(channel) ?? []) handler(data);
		},
	};
	let aborts = 0;
	let toolCalls = 0;

	const mockPi = {
		registerTool: () => {},
		registerCommand: () => {},
		on: (event: string, handler: (...args: never[]) => unknown) => {
			handlers[event] = handler as HandlerMap[string];
		},
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		sendMessage: (msg: { customType?: string; details?: unknown }) => {
			sentMessages.push(msg);
		},
		sendUserMessage: () => {},
		getActiveTools: () => ["read", "bash", "edit", "write"],
		setActiveTools: () => {},
		hasUI: false,
		events,
	};

	const ctx = {
		cwd,
		hasUI: false,
		sessionManager: {
			getBranch: () => [],
			getCwd: () => cwd,
			getSessionId: () => "test-session",
			getRoot: () => cwd,
			append: () => {},
			appendModelChange: () => {},
			appendThinkingLevelChange: () => {},
			appendCompetingWriteCheck: () => {},
			buildSessionContext: () => ({ messages: [], sessionId: "test", model: null, thinkingLevel: "medium" }),
		},
		getSystemPrompt: () => "",
		isIdle: () => false,
		hasPendingMessages: () => true,
		abort: () => { aborts++; },
		ui: { notify: (message: string, level?: string) => { notifications.push({ message, level }); } },
	} as unknown as ExtensionContext & { abort: () => void };

	piGoalExtension(mockPi as never);

	return {
		handlers,
		sentMessages,
		notifications,
		events,
		get aborts() { return aborts; },
		get toolCalls() { return toolCalls; },
		ctx,
	};
}

function fixtureCwd(): { cwd: string; goal: GoalRecord } {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-stale-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	writeFileSync(path.join(cwd, ".pi", "goals", "active_goal_fixture.md"), FIXTURE_GOAL);

	// The fixture's JSON header is authoritative here: read it back through the
	// extension's own parser path so the goal record matches what loadState sees.
	const parsed = createGoal({ objective: "Golden fixture goal objective", autoContinue: true, sisyphus: false }, Date.UTC(2026, 7, 3, 9, 0, 0));
	// Overwrite the fixture with a record whose id we know, then write via the
	// extension's serializer so the activePath is correct.
	writeFileSync(path.join(cwd, ".pi", "goals", "active_goal_fixture.md"), FIXTURE_GOAL);
	return { cwd, goal: { ...parsed, id: "golden_fixture_goal" } };
}

function sessionEntriesFor(goal: GoalRecord) {
	const stateEntry: GoalStateEntry = {
		version: 3,
		goal: {
			...goal,
			activePath: ".pi/goals/active_goal_fixture.md",
			usage: { tokensUsed: 0, activeSeconds: 0 },
			taskList: undefined,
			verificationContract: undefined,
		},
	};
	return [
		{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") },
		{ type: "custom", customType: "pi-goal-state", data: stateEntry },
	];
}

async function startSession(handlers: HandlerMap, ctx: ExtensionContext, entries: unknown[]) {
	const ss = handlers["session_start"];
	assert.ok(ss, "session_start handler must be registered");
	await ss({ reason: "start" }, {
		...ctx,
		sessionManager: { ...ctx.sessionManager, getBranch: () => entries },
	} as unknown as ExtensionContext);
}

// ── Tests ────────────────────────────────────────────────────────────────────

test("golden: stale checkpoint for a non-focused goal aborts the turn and injects GOAL STALE", async () => {
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd);
	try {
		await startSession(h.handlers, h.ctx, sessionEntriesFor(goal));

		const bas = h.handlers["before_agent_start"];
		assert.ok(bas);

		// A checkpoint claims a goal that is not focused/active in this session.
		const result = await bas({
			systemPrompt: "base",
			prompt: '<pi_goal_continuation goal_id="ghost-goal" kind="checkpoint">continue',
			systemPromptOptions: {},
		}, h.ctx);

		assert.equal(h.aborts, 1, "stale checkpoint must abort the turn");
		const systemPrompt = (result as { systemPrompt?: string } | undefined)?.systemPrompt ?? "";
		assert.match(systemPrompt, /\[GOAL STALE goalId=ghost-goal\]/);
		assert.match(systemPrompt, /Do not perform task work for this stale checkpoint/);
	} finally {
		// temp dir cleanup is best-effort.
	}
});

test("golden: matching checkpoint proceeds without stale handling", async () => {
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd);
	try {
		await startSession(h.handlers, h.ctx, sessionEntriesFor(goal));

		const bas = h.handlers["before_agent_start"];
		assert.ok(bas);

		const result = await bas({
			systemPrompt: "base",
			prompt: `<pi_goal_continuation goal_id="${goal.id}" kind="checkpoint">continue`,
			systemPromptOptions: {},
		}, h.ctx);

		assert.equal(h.aborts, 0, "matching checkpoint must not abort");
		const systemPrompt = (result as { systemPrompt?: string } | undefined)?.systemPrompt ?? "";
		assert.doesNotMatch(systemPrompt, /GOAL STALE/);
	} finally {
		// temp dir cleanup is best-effort.
	}
});

test("golden: user-driven turn cancels a pending continuation", async () => {
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd);
	try {
		await startSession(h.handlers, h.ctx, sessionEntriesFor(goal));

		// Simulate a work turn that queues a continuation: turn_start, a bash
		// tool call, then a non-tool-use assistant message at turn_end.
		await h.handlers["turn_start"]!({}, h.ctx);
		await h.handlers["tool_call"]!({ toolName: "bash", args: { command: "ls" } }, h.ctx);
		await h.handlers["tool_execution_end"]!({}, h.ctx);
		await h.handlers["turn_end"]!({ message: { role: "assistant", content: [{ type: "text", text: "done" }] } }, h.ctx);

		// The continuation timer is pending (non-idle ctx keeps it scheduled).
		// A user-driven turn must cancel it before it fires.
		await h.handlers["before_agent_start"]!({
			systemPrompt: "base",
			prompt: "user typed a new instruction",
			systemPromptOptions: {},
		}, h.ctx);

		// Wait beyond the idle retry delay; the queued continuation must not fire.
		await new Promise((resolve) => setTimeout(resolve, 120));

		const checkpoints = h.sentMessages.filter(
			(m) => m.customType === "pi-goal-event" && (m.details as { kind?: string } | undefined)?.kind === "checkpoint",
		);
		assert.equal(checkpoints.length, 0, "user turn must cancel the pending continuation");
	} finally {
		// temp dir cleanup is best-effort.
	}
});

// ── Provider-error guard (danim47c pattern) ─────────────────────────────────
// A turn/run whose assistant message has stopReason "error" is failed work:
// it must never queue an auto-continuation, or a provider outage turns into
// an unbounded retry storm. Normal turns must still queue.

/** Idle ctx: continuation fires immediately instead of rescheduling. */
function idleCtx(ctx: ExtensionContext): ExtensionContext {
	return {
		...ctx,
		isIdle: () => true,
		hasPendingMessages: () => false,
	} as unknown as ExtensionContext;
}

async function countCheckpoints(h: ReturnType<typeof createHarness>): Promise<number> {
	await new Promise((resolve) => setTimeout(resolve, 20));
	return h.sentMessages.filter(
		(m) => m.customType === "pi-goal-event" && (m.details as { kind?: string } | undefined)?.kind === "checkpoint",
	).length;
}

test("provider-error guard: turn_end with stopReason=error never queues a continuation", async () => {
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd);
	try {
		await startSession(h.handlers, h.ctx, sessionEntriesFor(goal));

		// Cancel the continuation session_start armed (non-idle ctx keeps it
		// scheduled) so the turn itself owns the queue decision.
		await h.handlers["before_agent_start"]!({
			systemPrompt: "base",
			prompt: "user typed: continue",
			systemPromptOptions: {},
		}, h.ctx);

		// A work turn that ends in a provider error (work tool ran, then error).
		await h.handlers["turn_start"]!({}, h.ctx);
		await h.handlers["tool_call"]!({ toolName: "bash", args: { command: "ls" } }, h.ctx);
		await h.handlers["tool_execution_end"]!({}, h.ctx);
		await h.handlers["turn_end"]!({ message: { role: "assistant", stopReason: "error" } }, idleCtx(h.ctx));

		assert.equal(await countCheckpoints(h), 0, "error turn must not queue a continuation");
	} finally {
		// temp dir cleanup is best-effort.
	}
});

test("provider-error guard: normal work turn still queues a continuation", async () => {
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd);
	try {
		await startSession(h.handlers, h.ctx, sessionEntriesFor(goal));

		// Cancel the continuation session_start armed (see above).
		await h.handlers["before_agent_start"]!({
			systemPrompt: "base",
			prompt: "user typed: continue",
			systemPromptOptions: {},
		}, h.ctx);

		await h.handlers["turn_start"]!({}, h.ctx);
		await h.handlers["tool_call"]!({ toolName: "bash", args: { command: "ls" } }, h.ctx);
		await h.handlers["tool_execution_end"]!({}, h.ctx);
		await h.handlers["turn_end"]!({ message: { role: "assistant", content: [{ type: "text", text: "done" }] } }, idleCtx(h.ctx));

		assert.equal(await countCheckpoints(h), 1, "normal work turn must queue a continuation");
	} finally {
		// temp dir cleanup is best-effort.
	}
});

test("provider-error guard: agent_end with an error message never queues a continuation", async () => {
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd);
	try {
		await startSession(h.handlers, h.ctx, sessionEntriesFor(goal));

		await h.handlers["agent_end"]!({ messages: [{ role: "assistant", stopReason: "error" }] }, idleCtx(h.ctx));
		await h.handlers["agent_settled"]!({}, idleCtx(h.ctx));

		assert.equal(await countCheckpoints(h), 0, "agent_end with an error message must not queue a continuation");
	} finally {
		// temp dir cleanup is best-effort.
	}
});

test("network-error recovery waits for agent_settled before scheduling its backoff", async () => {
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd);
	try {
		await startSession(h.handlers, h.ctx, sessionEntriesFor(goal));
		await h.handlers["before_agent_start"]!({
			systemPrompt: "base",
			prompt: "user typed: continue",
			systemPromptOptions: {},
		}, h.ctx);

		await h.handlers["agent_end"]!({
			messages: [{ role: "assistant", stopReason: "error", errorMessage: "Provider finish_reason: network_error" }],
		}, idleCtx(h.ctx));
		assert.equal(await countCheckpoints(h), 0, "agent_end must not race Pi's built-in retries");

		await h.handlers["agent_settled"]!({}, idleCtx(h.ctx));
		assert.equal(await countCheckpoints(h), 0, "the first recovery is delayed by the backoff policy");
		assert.match(h.notifications.at(-1)?.message ?? "", /Retrying the goal in 5s \(recovery 1, unbounded\)/);
	} finally {
		// The delayed timer is unref'd and needs no test teardown.
	}
});

test("a successful Pi retry clears the pending network-error recovery", async () => {
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd);
	try {
		await startSession(h.handlers, h.ctx, sessionEntriesFor(goal));
		await h.handlers["before_agent_start"]!({
			systemPrompt: "base",
			prompt: "user typed: continue",
			systemPromptOptions: {},
		}, h.ctx);

		await h.handlers["agent_end"]!({
			messages: [{ role: "assistant", stopReason: "error", errorMessage: "Provider finish_reason: network_error" }],
		}, idleCtx(h.ctx));
		await h.handlers["agent_end"]!({
			messages: [{ role: "assistant", stopReason: "end_turn" }],
		}, idleCtx(h.ctx));
		await h.handlers["agent_settled"]!({}, idleCtx(h.ctx));

		assert.equal(await countCheckpoints(h), 1, "the successful Pi retry uses the normal continuation path");
		assert.equal(h.notifications.length, 0, "no goal-level recovery is announced after Pi retries successfully");
	} finally {
		// No delayed timer should exist after the successful retry.
	}
});

test("successful agent_end waits for agent_settled before queuing a continuation", async () => {
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd);
	try {
		await startSession(h.handlers, h.ctx, sessionEntriesFor(goal));

		await h.handlers["agent_end"]!({ messages: [{ role: "assistant", stopReason: "end_turn" }] }, idleCtx(h.ctx));
		assert.equal(await countCheckpoints(h), 0, "agent_end runs before pi is truly idle");

		await h.handlers["agent_settled"]!({}, idleCtx(h.ctx));
		assert.equal(await countCheckpoints(h), 1, "agent_settled queues the continuation without idle polling");
	} finally {
		// temp dir cleanup is best-effort.
	}
});

// ── Fork: continuation cooldown + background-run wake (patches 1 + 2) ────────
// The two patches intentionally diverge from upstream 0.31.2: a turn whose
// progress calls were all read-only/goal-bookkeeping ("hygiene") no longer
// wakes immediately, and any turn waits while a background workflow/subagent
// run is live (the run's completion event is the wake, the idle delay is the
// deadline). Objective work (write/edit/bash) keeps the upstream cadence.

async function userTurn(h: ReturnType<typeof createHarness>): Promise<void> {
	await h.handlers["before_agent_start"]!({
		systemPrompt: "base",
		prompt: "user typed: continue",
		systemPromptOptions: {},
	}, h.ctx);
}

async function settleTurn(h: ReturnType<typeof createHarness>, toolName?: string, args: Record<string, unknown> = {}): Promise<void> {
	await h.handlers["turn_start"]!({}, h.ctx);
	if (toolName) {
		await h.handlers["tool_call"]!({ toolName, args }, h.ctx);
		await h.handlers["tool_execution_end"]!({}, h.ctx);
	}
	const message = { role: "assistant", content: [{ type: "text", text: "done" }] };
	await h.handlers["turn_end"]!({ message }, idleCtx(h.ctx));
	await h.handlers["agent_end"]!({ messages: [message] }, idleCtx(h.ctx));
	await h.handlers["agent_settled"]!({}, idleCtx(h.ctx));
}

test("fork patch 1: hygiene-only turns wait out the continuation cooldown (turn_end + agent_settled)", async () => {
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd);
	try {
		await startSession(h.handlers, h.ctx, sessionEntriesFor(goal));
		await userTurn(h);

		// A read-only work turn is the audit's waste class: it must not re-arm an
		// immediate checkpoint at either re-queue gate.
		await settleTurn(h, "read", { path: "README.md" });
		assert.equal(await countCheckpoints(h), 0, "read-only turn waits out the cooldown instead of waking immediately");
	} finally {
		// temp dir cleanup is best-effort.
	}
});

test("fork patch 1: goal-bookkeeping calls are hygiene too (update_goal_task)", async () => {
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd);
	try {
		await startSession(h.handlers, h.ctx, sessionEntriesFor(goal));
		await userTurn(h);

		await settleTurn(h, "update_goal_task", {});
		assert.equal(await countCheckpoints(h), 0, "routine goal hygiene must not reset the cooldown");
	} finally {
		// temp dir cleanup is best-effort.
	}
});

test("fork patch 1: objective-work turns keep the upstream immediate wake", async () => {
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd);
	try {
		await startSession(h.handlers, h.ctx, sessionEntriesFor(goal));
		await userTurn(h);

		await settleTurn(h, "write", { path: "src/x.ts", content: "x" });
		assert.equal(await countCheckpoints(h), 1, "write/edit/bash turns keep the round-trip continuation cadence");
	} finally {
		// temp dir cleanup is best-effort.
	}
});

test("fork patch 2: a live background run holds even objective-work turns", async () => {
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd);
	try {
		await startSession(h.handlers, h.ctx, sessionEntriesFor(goal));
		await userTurn(h);

		// pi-subagents background spawn (the producer delivers completion back
		// into this session with triggerTurn: true when it finishes).
		h.events.emit("subagents:created", { id: "agent-1", type: "general-purpose", description: "audit", isBackground: true });
		await settleTurn(h, "write", { path: "src/x.ts", content: "x" });
		assert.equal(await countCheckpoints(h), 0, "the background completion event is the wake, not an unconditional re-queue");

		// Settled: the registry no longer holds the goal, and a later productive
		// turn resumes the upstream cadence.
		h.events.emit("subagents:completed", { id: "agent-1", status: "completed" });
		await userTurn(h);
		await settleTurn(h, "write", { path: "src/x.ts", content: "y" });
		assert.equal(await countCheckpoints(h), 1, "after the run settles the immediate cadence returns");
	} finally {
		// temp dir cleanup is best-effort.
	}
});

test("fork patch 2: workflow lifecycle events hold and release the continuation gate", async () => {
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd);
	try {
		await startSession(h.handlers, h.ctx, sessionEntriesFor(goal));
		await userTurn(h);

		h.events.emit("pi-dynamic-workflows:lifecycle", { status: "started", runId: "run-1", name: "audit", sessionId: "test-session" });
		await settleTurn(h, "write", { path: "src/x.ts", content: "x" });
		assert.equal(await countCheckpoints(h), 0, "a live workflow run holds the continuation");

		h.events.emit("pi-dynamic-workflows:lifecycle", { status: "completed", runId: "run-1", name: "audit", sessionId: "test-session" });
		await userTurn(h);
		await settleTurn(h, "write", { path: "src/x.ts", content: "y" });
		assert.equal(await countCheckpoints(h), 1, "workflow completion releases the gate");
	} finally {
		// temp dir cleanup is best-effort.
	}
});

test("fork patch 2: another session's workflow run cannot hold this session", async () => {
	const { cwd, goal } = fixtureCwd();
	const h = createHarness(cwd);
	try {
		await startSession(h.handlers, h.ctx, sessionEntriesFor(goal));
		await userTurn(h);

		h.events.emit("pi-dynamic-workflows:lifecycle", { status: "started", runId: "run-2", name: "other", sessionId: "other-session" });
		await settleTurn(h, "write", { path: "src/x.ts", content: "x" });
		assert.equal(await countCheckpoints(h), 1, "a foreign session's run is not a wake this session can receive");
	} finally {
		// temp dir cleanup is best-effort.
	}
});
