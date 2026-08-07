import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";

const tempDirs: string[] = [];
afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

interface RegistryInternals {
	readLatestRlmSubagentRegistryPath(path: string | undefined, throwOnReadError?: boolean): Promise<unknown[]>;
}

function registryEntry(childId: string): string {
	return `${JSON.stringify({
		type: "rlm_subagent",
		childId,
		sessionName: childId,
		sessionDir: `/tmp/${childId}`,
		sessionFile: `/tmp/${childId}/session.jsonl`,
		status: "running",
	})}\n`;
}

describe("RLM subagent registry read coalescing", () => {
	it("serves concurrent readers of one registry from a single read", async () => {
		const directory = mkdtempSync(join(tmpdir(), "rlm-registry-"));
		tempDirs.push(directory);
		mkdirSync(join(directory, "artifacts"), { recursive: true });
		const registryPath = join(directory, "artifacts", "rlm-subagents.jsonl");
		writeFileSync(registryPath, registryEntry("child-1") + registryEntry("child-2"), "utf8");

		const daemon = new AgentDaemon(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			createRuntime: vi.fn(),
		}) as unknown as RegistryInternals;

		const results = await Promise.all(
			Array.from({ length: 50 }, () => daemon.readLatestRlmSubagentRegistryPath(registryPath)),
		);

		expect(results[0]).toHaveLength(2);
		// One read backs every concurrent caller, so they share the same array.
		for (const result of results) {
			expect(result).toBe(results[0]);
		}
	});

	it("reads again once the in-flight read settles", async () => {
		const directory = mkdtempSync(join(tmpdir(), "rlm-registry-"));
		tempDirs.push(directory);
		mkdirSync(join(directory, "artifacts"), { recursive: true });
		const registryPath = join(directory, "artifacts", "rlm-subagents.jsonl");
		writeFileSync(registryPath, registryEntry("child-1"), "utf8");

		const daemon = new AgentDaemon(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			createRuntime: vi.fn(),
		}) as unknown as RegistryInternals;

		const first = await daemon.readLatestRlmSubagentRegistryPath(registryPath);
		expect(first).toHaveLength(1);

		writeFileSync(registryPath, registryEntry("child-1") + registryEntry("child-2"), "utf8");
		const second = await daemon.readLatestRlmSubagentRegistryPath(registryPath);

		expect(second).not.toBe(first);
		expect(second).toHaveLength(2);
	});
});
