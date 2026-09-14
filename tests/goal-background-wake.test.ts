/**
 * Unit tests for the fork patch 2 background-wake registry.
 *
 * The registry consumes both producers' in-process `pi.events` lifecycle
 * streams: @tintinweb/pi-subagents (`subagents:created/started/completed/
 * failed`) and @quintinshaw/pi-dynamic-workflows
 * (`pi-dynamic-workflows:lifecycle`). While a run is live, goal continuations
 * hold until the producer's completion delivery (or the idle-delay deadline).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { BackgroundWakeRegistry, createBackgroundWakeRegistry } from "../extensions/goal-background-wake.ts";

function fakeBus() {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	return {
		bus: {
			on(channel: string, handler: (data: unknown) => void) {
				const set = handlers.get(channel) ?? new Set<(data: unknown) => void>();
				set.add(handler);
				handlers.set(channel, set);
				return () => { set.delete(handler); };
			},
		},
		emit(channel: string, data: unknown) {
			for (const handler of handlers.get(channel) ?? []) handler(data);
		},
		handlerCount(channel: string) {
			return handlers.get(channel)?.size ?? 0;
		},
	};
}

test("subagent lifecycle: created/started open the gate, completed/failed close it", () => {
	const { bus, emit } = fakeBus();
	const registry = createBackgroundWakeRegistry();
	registry.attach(bus);

	assert.equal(registry.liveCount(), 0);
	emit("subagents:created", { id: "a1", type: "general-purpose", description: "x", isBackground: true });
	assert.equal(registry.liveCount(), 1);
	// started is the first event for RPC/detached spawns (no created event).
	emit("subagents:started", { id: "a2", type: "general-purpose", description: "y" });
	assert.equal(registry.liveCount(), 2);
	assert.deepEqual(registry.liveRunIds(), ["subagent:a1", "subagent:a2"]);

	emit("subagents:completed", { id: "a1", status: "completed" });
	assert.equal(registry.liveCount(), 1, "a completed run must release the gate");
	emit("subagents:failed", { id: "a2", status: "failed" });
	assert.equal(registry.liveCount(), 0);
});

test("subagent events without an id (or malformed payloads) are ignored", () => {
	const { bus, emit } = fakeBus();
	const registry = new BackgroundWakeRegistry();
	registry.attach(bus);
	emit("subagents:created", {});
	emit("subagents:created", null);
	emit("subagents:completed", "nope");
	assert.equal(registry.liveCount(), 0);
});

test("workflow lifecycle: started/resumed/paused are live; completed/failed/stopped release", () => {
	const { bus, emit } = fakeBus();
	const registry = createBackgroundWakeRegistry();
	registry.attach(bus);

	emit("pi-dynamic-workflows:lifecycle", { status: "started", runId: "r1", name: "w" });
	assert.equal(registry.liveCount(), 1);
	emit("pi-dynamic-workflows:lifecycle", { status: "paused", runId: "r1", name: "w" });
	assert.equal(registry.liveCount(), 1, "a usage-limit pause stays live (it resumes)");
	emit("pi-dynamic-workflows:lifecycle", { status: "resumed", runId: "r1", name: "w" });
	assert.equal(registry.liveCount(), 1);

	emit("pi-dynamic-workflows:lifecycle", { status: "completed", runId: "r1", name: "w" });
	assert.equal(registry.liveCount(), 0);
	emit("pi-dynamic-workflows:lifecycle", { status: "started", runId: "r2", name: "w" });
	emit("pi-dynamic-workflows:lifecycle", { status: "failed", runId: "r2", name: "w" });
	emit("pi-dynamic-workflows:lifecycle", { status: "started", runId: "r3", name: "w" });
	emit("pi-dynamic-workflows:lifecycle", { status: "stopped", runId: "r3", name: "w" });
	assert.equal(registry.liveCount(), 0);
});

test("workflow lifecycle: unknown status and malformed payloads are ignored", () => {
	const { bus, emit } = fakeBus();
	const registry = new BackgroundWakeRegistry();
	registry.attach(bus);
	emit("pi-dynamic-workflows:lifecycle", { status: "spinning", runId: "r1", name: "w" });
	emit("pi-dynamic-workflows:lifecycle", { status: "started", name: "w" });
	emit("pi-dynamic-workflows:lifecycle", "nope");
	assert.equal(registry.liveCount(), 0);
});

test("workflow lifecycle: another session's run is never counted", () => {
	const { bus, emit } = fakeBus();
	const registry = createBackgroundWakeRegistry();
	registry.attach(bus);
	registry.setSessionId("session-me");

	emit("pi-dynamic-workflows:lifecycle", { status: "started", runId: "foreign", name: "w", sessionId: "session-other" });
	assert.equal(registry.liveCount(), 0, "a foreign session's run cannot deliver a wake here");

	emit("pi-dynamic-workflows:lifecycle", { status: "started", runId: "mine", name: "w", sessionId: "session-me" });
	assert.equal(registry.liveCount(), 1);

	// Legacy payloads without a sessionId are counted.
	emit("pi-dynamic-workflows:lifecycle", { status: "started", runId: "legacy", name: "w" });
	assert.equal(registry.liveCount(), 2);
});

test("attach is safe without a bus and detachAll unsubscribes", () => {
	const registry = createBackgroundWakeRegistry();
	registry.attach(undefined);
	registry.attach(null);
	assert.equal(registry.liveCount(), 0, "no producer attached means no background gate (patch 1 still governs)");

	const { bus, emit, handlerCount } = fakeBus();
	registry.attach(bus);
	assert.equal(handlerCount("subagents:created"), 1);
	registry.detachAll();
	assert.equal(handlerCount("subagents:created"), 0, "detach removes every channel subscription");
	emit("subagents:created", { id: "a1" });
	assert.equal(registry.liveCount(), 0);
});
