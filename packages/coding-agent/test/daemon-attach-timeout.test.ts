import { describe, expect, it, vi } from "vitest";
import { DaemonAgentConnection } from "../src/modes/agent-connection/daemon-agent-connection.js";
import type { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import { DAEMON_ATTACH_REQUEST_TIMEOUT_MS } from "../src/modes/daemon/daemon-protocol.js";

function summaryResponse() {
	return {
		type: "response" as const,
		command: "attach",
		success: true as const,
		data: {
			id: "session-1",
			sessionId: "session-1",
			activeSessionId: "active-1",
			lifecycle: "live",
			activity: "idle",
			isSessionActive: true,
			cwd: "/tmp/project",
			sessionFile: "/tmp/project/session.jsonl",
		},
	};
}

describe("daemon attach request budget", () => {
	it("gives attach a longer budget than the generic request default", async () => {
		const request = vi.fn(async (_command: { type?: string }, _timeoutMs?: number) => summaryResponse());
		const client = {
			request,
			onMessage: vi.fn(() => () => {}),
			onClose: vi.fn(() => () => {}),
			enableRequestRecovery: vi.fn(),
			socketPath: "/tmp/prime-agent-test/daemon.sock",
		} as unknown as DaemonClient;

		await DaemonAgentConnection.attach(client, "active-1", { supportsExtensionUi: false });

		const attachCall = request.mock.calls.find((call) => call[0].type === "attach");
		expect(attachCall).toBeDefined();
		expect(attachCall?.[1]).toBe(DAEMON_ATTACH_REQUEST_TIMEOUT_MS);
		// The generic default is 30s; a busy worker needs longer to build a snapshot.
		expect(DAEMON_ATTACH_REQUEST_TIMEOUT_MS).toBeGreaterThan(30_000);
	});
});
