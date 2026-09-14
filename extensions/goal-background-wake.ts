/**
 * Background-run wake registry — fork patch 2 (event-driven goal continuation).
 *
 * Goal auto-continuations used to re-queue with a 0 ms idle delay after any
 * turn that touched a progress tool (`goal-events.ts` turn_end /
 * `agent_settled`). While a background workflow or sub-agent runs, that loop
 * is pure waste: the producers already deliver the completion back into this
 * session as a follow-up turn (`pi.sendMessage(..., { triggerTurn: true,
 * deliverAs: "followUp" })`), so the completion *is* the wake. This registry
 * tracks live background runs off both producers' in-process `pi.events`
 * lifecycle streams and lets `GoalRuntime` hold the continuation until either
 * the completion event arrives or the idle-delay deadline fires.
 *
 * Producers and channels (verified 2026-09-14 against the installed packages):
 *   - @tintinweb/pi-subagents: `subagents:created` (Agent-tool background
 *     spawns / detached resumes), `subagents:started`, `subagents:completed`,
 *     `subagents:failed`.
 *   - @quintinshaw/pi-dynamic-workflows: `pi-dynamic-workflows:lifecycle`
 *     with `{ status: started | resumed | paused | completed | failed | stopped,
 *     runId, name, sessionId? }`.
 *
 * Failure posture: if no producer is loaded the registry stays empty and the
 * continuation cooldown alone governs (patch 1). If a completion event is
 * ever missed the deadline timer still fires, so a leaked entry costs at most
 * the idle-delay cadence, never a stall. Unknown/legacy producers are
 * intentionally not guessed at here — the systemd transient-timer pattern
 * documented in the fork README is the external deadline for those.
 */

export interface EventBusLike {
	on(channel: string, handler: (data: unknown) => void): () => void;
}

const SUBAGENT_CREATED_EVENT = "subagents:created";
const SUBAGENT_STARTED_EVENT = "subagents:started";
const SUBAGENT_COMPLETED_EVENT = "subagents:completed";
const SUBAGENT_FAILED_EVENT = "subagents:failed";
const WORKFLOW_LIFECYCLE_EVENT = "pi-dynamic-workflows:lifecycle";

const SUBAGENT_RUN_PREFIX = "subagent:";
const WORKFLOW_RUN_PREFIX = "workflow:";

const LIVE_WORKFLOW_STATUSES = new Set(["started", "resumed", "paused"]);
const SETTLED_WORKFLOW_STATUSES = new Set(["completed", "failed", "stopped"]);

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export class BackgroundWakeRegistry {
	private readonly live = new Set<string>();
	private sessionId: string | null = null;
	private detach: Array<() => void> = [];

	/** Subscribe to both producers' lifecycle channels. Safe without a bus. */
	attach(events: EventBusLike | null | undefined): void {
		if (!events || typeof events.on !== "function") return;
		const subscribe = (channel: string, handler: (data: unknown) => void): void => {
			try {
				this.detach.push(events.on(channel, handler));
			} catch {
				// A producer's bus is optional; never let it break the goal loop.
			}
		};
		subscribe(SUBAGENT_CREATED_EVENT, (data) => this.noteSubagentStarted(data));
		subscribe(SUBAGENT_STARTED_EVENT, (data) => this.noteSubagentStarted(data));
		subscribe(SUBAGENT_COMPLETED_EVENT, (data) => this.noteSubagentSettled(data));
		subscribe(SUBAGENT_FAILED_EVENT, (data) => this.noteSubagentSettled(data));
		subscribe(WORKFLOW_LIFECYCLE_EVENT, (data) => this.handleWorkflowLifecycle(data));
	}

	/** Unsubscribe all attached channels (session shutdown / tests). */
	detachAll(): void {
		for (const off of this.detach) {
			try {
				off();
			} catch {
				// Ignore teardown failures from a producer's bus.
			}
		}
		this.detach = [];
	}

	/**
	 * Current session id, when known. Workflow lifecycle payloads carry the
	 * originating run's session; runs from another session can never deliver a
	 * wake here, so they must not hold this session's continuation.
	 */
	setSessionId(sessionId: string | null | undefined): void {
		this.sessionId = sessionId ?? null;
	}

	/** Number of live background runs across attached producers. */
	liveCount(): number {
		return this.live.size;
	}

	/** Deterministic snapshot of live run keys (tests/debug). */
	liveRunIds(): string[] {
		return [...this.live].sort();
	}

	private noteSubagentStarted(data: unknown): void {
		const id = asRecord(data)?.id;
		if (typeof id === "string" && id.length > 0) this.live.add(SUBAGENT_RUN_PREFIX + id);
	}

	private noteSubagentSettled(data: unknown): void {
		const id = asRecord(data)?.id;
		if (typeof id === "string" && id.length > 0) this.live.delete(SUBAGENT_RUN_PREFIX + id);
	}

	private handleWorkflowLifecycle(data: unknown): void {
		const record = asRecord(data);
		const runId = record?.runId;
		const status = record?.status;
		if (typeof runId !== "string" || runId.length === 0 || typeof status !== "string") return;
		const eventSessionId = typeof record?.sessionId === "string" ? record.sessionId : undefined;
		if (eventSessionId !== undefined && this.sessionId !== null && eventSessionId !== this.sessionId) return;
		const key = WORKFLOW_RUN_PREFIX + runId;
		if (LIVE_WORKFLOW_STATUSES.has(status)) this.live.add(key);
		else if (SETTLED_WORKFLOW_STATUSES.has(status)) this.live.delete(key);
	}
}

export function createBackgroundWakeRegistry(): BackgroundWakeRegistry {
	return new BackgroundWakeRegistry();
}
