import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveAgentName, type AgentConfig } from "../../src/agents/agents.ts";

const makeAgent = (overrides: Partial<AgentConfig>): AgentConfig => ({
	name: "test-agent",
	description: "Test agent",
	systemPromptMode: "default",
	inheritProjectContext: true,
	inheritSkills: true,
	systemPrompt: "Test prompt",
	source: "project",
	filePath: "/tmp/test-agent.md",
	...overrides,
});

describe("B5: agent tool allowlist validation at resolve time", () => {
	it("rejects agent config with bare-name tool not in builtin set", () => {
		const agent = makeAgent({
			name: "scout",
			tools: ["intercom", "bash"], // "intercom" is not a builtin
		});

		const result = resolveAgentName("scout", [agent]);

		// B5 fix: resolveAgentName should validate tools and return error for unavailable tools
		// Current behavior: returns { agent } without validation
		// Expected after fix: returns { error: "..." } or strips invalid tools
		assert.ok(result.error, "should return error for unavailable tool 'intercom'");
		assert.match(result.error ?? "", /intercom/i, "error should mention the unavailable tool");
	});

	it("accepts agent config with only builtin tools", () => {
		const agent = makeAgent({
			name: "worker",
			tools: ["bash", "read", "write"],
		});

		const result = resolveAgentName("worker", [agent]);

		assert.ok(result.agent, "should resolve agent with valid builtin tools");
		assert.equal(result.error, undefined, "should not return error for valid tools");
	});

	it("accepts agent config with path-like extension tools", () => {
		const agent = makeAgent({
			name: "extended",
			tools: ["bash", "./extensions/custom-tool.ts"],
		});

		const result = resolveAgentName("extended", [agent]);

		assert.ok(result.agent, "should resolve agent with path-like extension tools");
		assert.equal(result.error, undefined, "should not return error for path-like tools");
	});
});
