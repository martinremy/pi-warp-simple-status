import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => process.env.PI_CODING_AGENT_DIR }));
import { loadSummaryConfig, summarizeTurn } from "../src/summary.js";

const config = { provider: "test", model: "small", timeoutMs: 10000 };
const good = "Created the requested branch from main";
function entry(message: unknown): SessionEntry {
  return { type: "message", id: "entry", parentId: null, timestamp: new Date(0).toISOString(), message } as SessionEntry;
}
function answer(content: unknown = [{ type: "text", text: "Created status-summary from main." }], stopReason = "stop") {
  return { role: "assistant", content, stopReason, api: "test", provider: "test", model: "small", timestamp: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function host(branch = [entry({ role: "user", content: "Create status-summary", timestamp: 0 }), entry(answer())]) {
  const result = vi.fn().mockResolvedValue(answer([{ type: "text", text: good }]));
  const streamSimple = vi.fn(() => ({ result }));
  const model = { id: "small", provider: "test" };
  const find = vi.fn(() => model);
  const ctx = { sessionManager: { getBranch: () => branch }, modelRegistry: { find, streamSimple } } as unknown as ExtensionContext;
  return { ctx, find, streamSimple, result, model };
}
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "warp-summary-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  vi.useFakeTimers();
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); vi.unstubAllEnvs(); });
function save(value: unknown) { writeFileSync(join(dir, "warp-simple-status.json"), JSON.stringify(value)); }

describe("summary configuration", () => {
  it("uses Pi's agent directory and defaults the deadline", () => {
    save({ summary: { provider: "test", model: "small" } });
    expect(loadSummaryConfig()).toEqual(config);
    save({ summary: { ...config, timeoutMs: 2500 } });
    expect(loadSummaryConfig()).toEqual({ ...config, timeoutMs: 2500 });
  });
  it("disables summaries for absent, malformed or unreadable configuration", () => {
    expect(loadSummaryConfig()).toBeUndefined();
    writeFileSync(join(dir, "warp-simple-status.json"), "{");
    expect(loadSummaryConfig()).toBeUndefined();
    rmSync(join(dir, "warp-simple-status.json")); mkdirSync(join(dir, "warp-simple-status.json"));
    expect(loadSummaryConfig()).toBeUndefined();
  });
  it.each([null, [], {}, { summary: null }, { summary: {} },
    { summary: { ...config, provider: " " } }, { summary: { ...config, model: 2 } },
    ...[0, -1, 1.5, "100", 2147483648, null].map(timeoutMs => ({ summary: { ...config, timeoutMs } })),
  ])("rejects invalid configuration %j", (value) => {
    save(value); expect(loadSummaryConfig()).toBeUndefined();
  });
});

describe("turn summary", () => {
  it("sends only the latest request and final text through the configured Pi model", async () => {
    const h = host([
      entry({ role: "user", content: "OLD REQUEST", timestamp: 0 }), entry(answer([{ type: "text", text: "OLD ANSWER" }])),
      entry({ role: "user", content: [{ type: "text", text: "Create status-summary" }, { type: "image", data: "IMAGE SECRET", mimeType: "image/png" }], timestamp: 1 }),
      entry(answer([{ type: "text", text: "INTERMEDIATE" }, { type: "toolCall", id: "x", name: "bash", arguments: { secret: "TOOL INPUT" } }], "toolUse")),
      entry({ role: "toolResult", toolCallId: "x", toolName: "bash", content: [{ type: "text", text: "TOOL OUTPUT" }], isError: false, timestamp: 1 }),
      entry(answer([{ type: "thinking", thinking: "THINKING SECRET" }, { type: "text", text: "Created status-summary from main." }])),
    ]);
    expect(await summarizeTurn(h.ctx, config, new AbortController().signal)).toBe(good);
    expect(h.find).toHaveBeenCalledWith("test", "small");
    const [model, input, options] = h.streamSimple.mock.calls[0] as unknown as [unknown, { messages: Array<{ role: string; content: string }>; tools?: unknown }, { signal: AbortSignal; maxRetries: number }];
    expect(model).toBe(h.model);
    expect(JSON.parse(input.messages[0].content)).toEqual({ request: "Create status-summary", answer: "Created status-summary from main." });
    expect(input.messages).toHaveLength(1);
    expect(input.tools).toBeUndefined();
    expect(options.maxRetries).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds text input to 12000 characters without dropping the answer", async () => {
    const h = host([entry({ role: "user", content: "u".repeat(20000), timestamp: 0 }), entry(answer([{ type: "text", text: "a".repeat(20000) }]))]);
    await summarizeTurn(h.ctx, config, new AbortController().signal);
    const input = (h.streamSimple.mock.calls[0] as unknown as [unknown, { messages: Array<{ content: string }> }])[1];
    const text = JSON.parse(input.messages[0].content);
    expect(text.request.length + text.answer.length).toBeLessThanOrEqual(12000);
    expect(text.request.length).toBeGreaterThan(0); expect(text.answer.length).toBeGreaterThan(0);
  });
  it.each(["error", "aborted", "toolUse", "length", "pending"])("does not summarize earlier successful text when latest assistant ended with %s", async (reason) => {
    const h = host([entry({ role: "user", content: "new", timestamp: 0 }), entry(answer()), entry(answer([], reason))]);
    expect(await summarizeTurn(h.ctx, config, new AbortController().signal)).toBeUndefined();
    expect(h.streamSimple).not.toHaveBeenCalled();
  });
  it.each([
    [],
    [entry(answer()), entry({ role: "user", content: "new", timestamp: 0 })],
    [entry({ role: "user", content: "new", timestamp: 0 }), entry(answer([{ type: "thinking", thinking: "secret" }]))],
  ].map(branch => [branch] as const))("falls back without usable current-turn text", async (branch) => {
    const h = host(branch);
    expect(await summarizeTurn(h.ctx, config, new AbortController().signal)).toBeUndefined();
    expect(h.streamSimple).not.toHaveBeenCalled();
  });
  it("reports fallback reasons without conversation content or provider errors", async () => {
    const h = host(); const report = vi.fn();
    h.result.mockResolvedValue(answer([{ type: "text", text: "PRIVATE PROVIDER TEXT" }], "length"));
    expect(await summarizeTurn(h.ctx, config, new AbortController().signal, report)).toBeUndefined();
    expect(report.mock.calls).toEqual([["request_started"], ["incomplete_length"]]);
    report.mockClear(); h.result.mockRejectedValue(new Error("PRIVATE PROVIDER ERROR"));
    expect(await summarizeTurn(h.ctx, config, new AbortController().signal, report)).toBeUndefined();
    expect(report.mock.calls).toEqual([["request_started"], ["request_failed"]]);
  });
  it("normalizes output whitespace", async () => {
    const h = host(); h.result.mockResolvedValue(answer([{ type: "text", text: "  Created   the requested\nbranch from main  " }]));
    expect(await summarizeTurn(h.ctx, config, new AbortController().signal)).toBe(good);
  });
  it.each(["", "Too few words", "one two three four five six seven eight nine", "one two three four five\x1b", `${"a".repeat(160)} two three four five`])("rejects invalid output %j", async (text) => {
    const h = host(); h.result.mockResolvedValue(answer([{ type: "text", text }]));
    expect(await summarizeTurn(h.ctx, config, new AbortController().signal)).toBeUndefined();
  });
  it.each(["error", "aborted", "length"])("rejects incomplete model result %s", async (reason) => {
    const h = host(); h.result.mockResolvedValue(answer([{ type: "text", text: good }], reason));
    expect(await summarizeTurn(h.ctx, config, new AbortController().signal)).toBeUndefined();
  });
  it("contains unavailable model, lookup, provider and auth failures", async () => {
    for (const failure of ["missing", "lookup", "stream", "result"]) {
      const h = host();
      if (failure === "missing") h.find.mockReturnValue(undefined as never);
      if (failure === "lookup") h.find.mockImplementation(() => { throw new Error("lookup"); });
      if (failure === "stream") h.streamSimple.mockImplementation(() => { throw new Error("auth"); });
      if (failure === "result") h.result.mockRejectedValue(new Error("provider"));
      expect(await summarizeTurn(h.ctx, config, new AbortController().signal)).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    }
  });
  it("bounds the whole attempt even when provider/auth ignores abort", async () => {
    const h = host(); h.result.mockReturnValue(new Promise(() => {}));
    const pending = summarizeTurn(h.ctx, config, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(9999);
    const options = (h.streamSimple.mock.calls[0] as unknown as [unknown, unknown, { signal: AbortSignal }])[2];
    expect(options.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBeUndefined(); expect(options.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels promptly and clears the deadline on external abort", async () => {
    const h = host(); h.result.mockReturnValue(new Promise(() => {})); const controller = new AbortController();
    const pending = summarizeTurn(h.ctx, config, controller.signal);
    controller.abort();
    expect(await pending).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  });
  it("never starts a provider request when already cancelled", async () => {
    const h = host(); const controller = new AbortController(); controller.abort();
    expect(await summarizeTurn(h.ctx, config, controller.signal)).toBeUndefined();
    expect(h.streamSimple).not.toHaveBeenCalled();
  });
});
