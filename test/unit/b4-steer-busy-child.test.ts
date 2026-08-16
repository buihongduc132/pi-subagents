import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import {
	SUBAGENT_STEER_INBOX_ENV,
	SUBAGENT_STEER_CAPABILITY_ENV,
	SUBAGENT_STEER_ACK_DIR_ENV,
	SUBAGENT_CHILD_INDEX_ENV,
} from "../../src/runs/shared/pi-args.ts";
import { registerSteeringInbox } from "../../src/runs/shared/subagent-prompt-runtime.ts";
import { writeSteerRequestToDir } from "../../src/runs/background/control-channel.ts";

describe("B4: steer-on-busy child downgrade", () => {
	it("downgrades explicit steer to followUp when agent is busy, not throw", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b4-steer-busy-"));
		try {
			const inbox = path.join(dir, "steer");
			const ackDir = path.join(dir, "acks");
			fs.mkdirSync(ackDir, { recursive: true });
			process.env[SUBAGENT_STEER_INBOX_ENV] = inbox;
			process.env[SUBAGENT_STEER_ACK_DIR_ENV] = ackDir;
			process.env[SUBAGENT_CHILD_INDEX_ENV] = "0";

			const handlers = new Map<string, (payload?: unknown) => unknown>();
			const sent: Array<{ content: string; deliverAs?: string }> = [];
			let throwOnSteer = false;

			registerSteeringInbox({
				on(event: string, handler: (payload?: unknown) => unknown) {
					handlers.set(event, handler);
				},
				sendUserMessage(content: string, options?: { deliverAs?: string }) {
					// Simulate pi runtime throwing when steer arrives during active turn
					if (throwOnSteer && options?.deliverAs === "steer") {
						throw new Error("Agent is already processing — Specify streamingBehavior");
					}
					sent.push({ content, deliverAs: options?.deliverAs });
				},
			} as never);

			// Start session and agent (sets agentRunning=true)
			handlers.get("session_start")?.({});
			handlers.get("agent_start")?.({});
			// Trigger turn_start to set inTurn=true (mid-turn busy state)
			handlers.get("turn_start")?.({});

			// Enable throw-on-steer to simulate busy agent
			throwOnSteer = true;

			// Write explicit steer request (mode="steer" is default)
			writeSteerRequestToDir(inbox, {
				type: "steer",
				id: "busy-steer-1",
				ts: 1,
				message: "Focus on tests while busy.",
				mode: "steer",
			});

			// Trigger flush via message_start (which calls activate() → flush())
			handlers.get("message_start")?.({});

			// Shutdown BEFORE asserting so watcher doesn't hang the test process
			handlers.get("session_shutdown")?.({});

			// B4 fix: should downgrade to followUp when agentRunning=true, not throw
			// Current code: delivers as "steer" → throws "Agent is already processing"
			// Expected after fix: delivers as "followUp" → no throw
			assert.equal(sent.length, 1, "should send exactly one message");
			assert.equal(
				sent[0]?.deliverAs,
				"followUp",
				"busy steer should downgrade to followUp, not deliver as steer",
			);
		} finally {
			delete process.env[SUBAGENT_STEER_INBOX_ENV];
			delete process.env[SUBAGENT_STEER_CAPABILITY_ENV];
			delete process.env[SUBAGENT_STEER_ACK_DIR_ENV];
			delete process.env[SUBAGENT_CHILD_INDEX_ENV];
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
