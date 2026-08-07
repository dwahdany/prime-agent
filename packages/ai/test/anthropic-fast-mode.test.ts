import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { streamAnthropic } from "../src/providers/anthropic.js";
import type { AssistantMessage, Context, Model, ServiceTier } from "../src/types.js";

interface CapturedRequest {
	headers: IncomingMessage["headers"];
	body: Record<string, unknown>;
}

interface CapturedRun {
	request: CapturedRequest;
	message: AssistantMessage;
}

function createModel(baseUrl: string, id = "claude-opus-5"): Model<"anthropic-messages"> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1000000,
		maxTokens: 128000,
	};
}

function createContext(): Context {
	return { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] };
}

async function readRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

/** Minimal Anthropic stream: 1000 input tokens, 100 output tokens, no cache activity. */
function writeSseResponse(response: ServerResponse, speed: "fast" | "standard" | null): void {
	const usage = {
		input_tokens: 1000,
		output_tokens: 0,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: 0,
		...(speed === null ? {} : { speed }),
	};
	const events = [
		{
			event: "message_start",
			data: {
				type: "message_start",
				message: {
					id: "msg_test",
					type: "message",
					role: "assistant",
					model: "claude-opus-5",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage,
				},
			},
		},
		{
			event: "content_block_start",
			data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		},
		{
			event: "content_block_delta",
			data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		},
		{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
		{
			event: "message_delta",
			data: {
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 100 },
			},
		},
		{ event: "message_stop", data: { type: "message_stop" } },
	];

	response.writeHead(200, { "content-type": "text/event-stream" });
	for (const { event, data } of events) {
		response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	}
	response.end();
}

async function runAnthropicRequest(options: {
	serviceTier?: ServiceTier;
	modelId?: string;
	responseSpeed?: "fast" | "standard" | null;
}): Promise<CapturedRun> {
	let capturedRequest: CapturedRequest | undefined;

	const server = createServer(async (request, response) => {
		capturedRequest = { headers: request.headers, body: await readRequestBody(request) };
		writeSseResponse(response, options.responseSpeed ?? null);
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;

	let message: AssistantMessage;
	try {
		const stream = streamAnthropic(
			createModel(`http://127.0.0.1:${address.port}`, options.modelId),
			createContext(),
			{
				apiKey: "test-key",
				cacheRetention: "none",
				...(options.serviceTier === undefined ? {} : { serviceTier: options.serviceTier }),
			},
		);
		message = await stream.result();
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	}

	if (!capturedRequest) {
		throw new Error("Anthropic request was not captured");
	}
	return { request: capturedRequest, message };
}

describe("Anthropic fast mode", () => {
	it("sends speed=fast with the fast mode beta for the priority service tier", async () => {
		const { request } = await runAnthropicRequest({ serviceTier: "priority" });

		expect(request.body.speed).toBe("fast");
		expect(request.headers["anthropic-beta"]).toBe("fast-mode-2026-02-01");
	});

	it("omits speed without the priority service tier", async () => {
		const { request } = await runAnthropicRequest({ serviceTier: "default" });

		expect(request.body.speed).toBeUndefined();
		expect(request.headers["anthropic-beta"]).toBeUndefined();
	});

	it("omits speed for models that reject it", async () => {
		const { request } = await runAnthropicRequest({ serviceTier: "priority", modelId: "claude-opus-4-7" });

		expect(request.body.speed).toBeUndefined();
		expect(request.headers["anthropic-beta"]).toBeUndefined();
	});

	it("doubles cost when the response reports fast speed", async () => {
		const { message } = await runAnthropicRequest({ serviceTier: "priority", responseSpeed: "fast" });

		expect(message.usage.cost.input).toBeCloseTo(0.01, 10);
		expect(message.usage.cost.output).toBeCloseTo(0.005, 10);
		expect(message.usage.cost.total).toBeCloseTo(0.015, 10);
	});

	it("doubles cost when the response omits the speed it was asked for", async () => {
		const { message } = await runAnthropicRequest({ serviceTier: "priority" });

		expect(message.usage.cost.total).toBeCloseTo(0.015, 10);
	});

	it("bills standard rates when the response downgrades to standard speed", async () => {
		const { message } = await runAnthropicRequest({ serviceTier: "priority", responseSpeed: "standard" });

		expect(message.usage.cost.input).toBeCloseTo(0.005, 10);
		expect(message.usage.cost.output).toBeCloseTo(0.0025, 10);
		expect(message.usage.cost.total).toBeCloseTo(0.0075, 10);
	});

	it("bills standard rates without fast mode", async () => {
		const { message } = await runAnthropicRequest({});

		expect(message.usage.cost.total).toBeCloseTo(0.0075, 10);
	});
});
