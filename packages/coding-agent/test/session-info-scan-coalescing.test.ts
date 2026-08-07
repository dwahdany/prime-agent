import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionHeader } from "../src/core/session-manager.js";
import { readSessionInfo } from "../src/core/session-manager.js";

function writeSession(path: string, id: string, messages: number): void {
	const header: SessionHeader = {
		type: "session",
		id,
		version: 3,
		timestamp: new Date(0).toISOString(),
		cwd: "/tmp",
	};
	writeFileSync(path, `${JSON.stringify(header)}\n`, "utf8");
	appendSession(path, messages);
}

function appendSession(path: string, messages: number): void {
	let lines = "";
	for (let index = 0; index < messages; index++) {
		lines += `${JSON.stringify({
			type: "message",
			id: `m${index}-${Math.random()}`,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: "hello", timestamp: Date.now() },
		})}\n`;
	}
	appendFileSync(path, lines, "utf8");
}

describe("readSessionInfo scan coalescing", () => {
	it("serves concurrent readers of a changed file from a single scan", async () => {
		const directory = mkdtempSync(join(tmpdir(), "session-info-scan-"));
		const path = join(directory, "session.jsonl");
		writeSession(path, "coalesce-session", 50);

		// Prime the cache, then invalidate it the way a live session does.
		await readSessionInfo(path);
		appendSession(path, 50);

		const results = await Promise.all(Array.from({ length: 40 }, () => readSessionInfo(path)));

		expect(results[0]).not.toBeNull();
		// A single scan backs every concurrent caller, so they share one object.
		for (const result of results) {
			expect(result).toBe(results[0]);
		}
	});

	it("rescans after the in-flight scan settles", async () => {
		const directory = mkdtempSync(join(tmpdir(), "session-info-scan-"));
		const path = join(directory, "session.jsonl");
		writeSession(path, "rescan-session", 10);

		const first = await readSessionInfo(path);
		expect(first?.messageCount).toBe(10);

		appendSession(path, 5);
		const second = await readSessionInfo(path);

		expect(second).not.toBe(first);
		expect(second?.messageCount).toBe(15);
	});
});
