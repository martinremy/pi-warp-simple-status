import * as fs from "node:fs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(), openSync: vi.fn(), writeSync: vi.fn(), closeSync: vi.fn() }));
vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => process.env.PI_CODING_AGENT_DIR }));
import register from "../src/index.js";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
const summary = "Created the requested branch from main";
const key = Symbol.for("pi-subagents:manager");
let dir: string;
let originalManager: PropertyDescriptor | undefined;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function response(text = summary) { return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }; }
function context(id = "foreground", mode = "tui") {
  const pending = deferred<ReturnType<typeof response>>();
  const streamSimple = vi.fn((_model: unknown, _input: unknown, _options: { signal: AbortSignal }) => ({ result: () => pending.promise }));
  const ctx = { cwd: "/home/me/project", mode,
    sessionManager: { getSessionId: () => id, getBranch: () => [
      { type: "message", message: { role: "user", content: "Create branch", timestamp: 0 } },
      { type: "message", message: response("Created branch.") },
    ] }, modelRegistry: { find: () => ({ provider: "test", id: "small" }), streamSimple },
  } as unknown as ExtensionContext;
  return { ctx, pending, streamSimple };
}
function host() {
  const handlers = new Map<string, Handler>();
  register({ on: (name: string, handler: Handler) => handlers.set(name, handler) } as unknown as ExtensionAPI);
  return { fire: async (name: string, ctx: ExtensionContext) => { await handlers.get(name)?.({}, ctx); } };
}
function records(): Array<{ event: string; session_id: string; response?: string }> {
  return vi.mocked(fs.writeSync).mock.calls.map(call => JSON.parse(String(call[1]).slice("\x1b]777;notify;warp://cli-agent;".length, -1)));
}
function stops() { return records().filter(r => r.event === "stop"); }
async function flush() { await vi.advanceTimersByTimeAsync(0); }
async function start() { const h = host(); const c = context(); await h.fire("session_start", c.ctx); await h.fire("agent_start", c.ctx); return { h, ...c }; }
function manager(running: boolean) { const state = { running, hasRunning() { return this.running; } }; Object.defineProperty(globalThis, key, { value: state, configurable: true }); return state; }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "warp-summary-integration-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  writeFileSync(join(dir, "warp-simple-status.json"), JSON.stringify({ summary: { provider: "test", model: "small", timeoutMs: 10000 } }));
  vi.useFakeTimers();
  vi.stubEnv("TERM_PROGRAM", "WarpTerminal"); vi.stubEnv("WARP_CLI_AGENT_PROTOCOL_VERSION", "1"); vi.stubEnv("PI_WARP_SIMPLE_STATUS_TRACE", undefined);
  vi.mocked(fs.openSync).mockReturnValue(42); vi.mocked(fs.writeSync).mockReturnValue(1);
  originalManager = Object.getOwnPropertyDescriptor(globalThis, key); Reflect.deleteProperty(globalThis, key);
});
afterEach(() => {
  if (originalManager) Object.defineProperty(globalThis, key, originalManager); else Reflect.deleteProperty(globalThis, key);
  vi.clearAllTimers(); vi.useRealTimers(); vi.resetAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true });
});

describe("configured completion summaries", () => {
  it("starts only at settlement and sends one real stop payload with the summary", async () => {
    const { h, ctx, pending, streamSimple } = await start();
    await h.fire("agent_end", ctx); expect(streamSimple).not.toHaveBeenCalled();
    await h.fire("agent_settled", ctx); expect(streamSimple).toHaveBeenCalledTimes(1); expect(stops()).toEqual([]);
    await h.fire("agent_settled", ctx); expect(streamSimple).toHaveBeenCalledTimes(1);
    pending.resolve(response()); await flush();
    expect(stops()).toEqual([expect.objectContaining({ session_id: "foreground", response: summary })]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not start early to hide latency while manager work or existing grace remains", async () => {
    const state = manager(true); const { h, ctx, pending, streamSimple } = await start();
    await h.fire("agent_settled", ctx); await vi.advanceTimersByTimeAsync(30000);
    expect(streamSimple).not.toHaveBeenCalled();
    state.running = false; await vi.advanceTimersByTimeAsync(749); expect(streamSimple).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(streamSimple).toHaveBeenCalledTimes(1); expect(stops()).toHaveLength(0);
    await h.fire("agent_settled", ctx); await vi.advanceTimersByTimeAsync(1000); expect(streamSimple).toHaveBeenCalledTimes(1);
    pending.resolve(response()); await flush(); expect(stops()).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps the existing busy heartbeat while summarizing", async () => {
    writeFileSync(join(dir, "warp-simple-status.json"), JSON.stringify({ summary: { provider: "test", model: "small", timeoutMs: 30000 } }));
    const { h, ctx, pending } = await start(); await h.fire("agent_settled", ctx);
    await vi.advanceTimersByTimeAsync(15000);
    expect(records().map(r => r.event)).toEqual(["session_start", "prompt_submit", "prompt_submit"]);
    pending.resolve(response()); await flush(); expect(stops()).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("emits the exact static fallback on timeout even if the model never finishes", async () => {
    const { h, ctx, streamSimple } = await start(); await h.fire("agent_settled", ctx);
    await vi.advanceTimersByTimeAsync(9999); expect(stops()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(stops().map(r => r.response)).toEqual(["Pi finished responding."]);
    expect(streamSimple.mock.calls[0][2].signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["", "too short"])("emits static fallback for unusable model output %j", async text => {
    const { h, ctx, pending } = await start(); await h.fire("agent_settled", ctx);
    pending.resolve(response(text)); await flush(); expect(stops().map(r => r.response)).toEqual(["Pi finished responding."]);
  });
  it("writes real metadata-only fallback reasons to the opt-in trace", async () => {
    const path = join(dir, "trace.jsonl"); vi.stubEnv("PI_WARP_SIMPLE_STATUS_TRACE", path);
    const { h, ctx, pending } = await start(); await h.fire("agent_settled", ctx);
    pending.resolve({ ...response(), stopReason: "length" }); await flush();
    const trace = fs.readFileSync(path, "utf8");
    const diagnostics = trace.trim().split("\n").map(line => JSON.parse(line)).filter(record => record.kind === "summary");
    expect(diagnostics.map(record => record.event)).toEqual(["request_started", "incomplete_length"]);
    expect(trace).not.toContain(summary); expect(trace).not.toContain("Create branch");
    expect(stops().map(record => record.response)).toEqual(["Pi finished responding."]);
  });
  it("retains immediate static behavior without configuration", async () => {
    rmSync(join(dir, "warp-simple-status.json"));
    const { h, ctx, streamSimple } = await start(); await h.fire("agent_settled", ctx);
    expect(stops().map(r => r.response)).toEqual(["Pi finished responding."]); expect(streamSimple).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("discards a stale summary after new work in the same session, without stopping its heartbeat", async () => {
    const { h, ctx, pending, streamSimple } = await start(); await h.fire("agent_settled", ctx);
    const oldSignal = streamSimple.mock.calls[0][2].signal;
    await h.fire("agent_start", ctx); expect(oldSignal.aborted).toBe(true);
    pending.resolve(response()); await flush(); expect(stops()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(15000); expect(records().filter(r => r.event === "prompt_submit")).toHaveLength(2);
    await h.fire("agent_settled", ctx); await flush(); expect(stops()).toHaveLength(1); expect(streamSimple).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["session_start", "session_shutdown"])("cancels pending generation on %s without stale emission", async name => {
    const { h, ctx, pending, streamSimple } = await start(); await h.fire("agent_settled", ctx);
    await h.fire(name, name === "session_start" ? context("next").ctx : ctx);
    expect(streamSimple.mock.calls[0][2].signal.aborted).toBe(true);
    pending.resolve(response()); await flush(); expect(stops()).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
  });
  it("does not mark resumed managed work as done after the summary resolves", async () => {
    const state = manager(false); const { h, ctx, pending, streamSimple } = await start(); await h.fire("agent_settled", ctx);
    state.running = true; pending.resolve(response()); await flush(); expect(stops()).toHaveLength(0);
    state.running = false; await vi.advanceTimersByTimeAsync(750);
    expect(streamSimple).toHaveBeenCalledTimes(1); expect(stops()).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  });
  it.each([summary, ""])("retains the single result while resumed work drains, including fallback %j", async text => {
    const state = manager(false); const { h, ctx, pending, streamSimple } = await start(); await h.fire("agent_settled", ctx);
    state.running = true; await vi.advanceTimersByTimeAsync(250);
    state.running = false; await vi.advanceTimersByTimeAsync(250); // existing grace begins
    pending.resolve(response(text)); await flush(); expect(stops()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(499); expect(stops()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(stops().map(r => r.response)).toEqual([text || "Pi finished responding."]);
    expect(streamSimple).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("ignores noninteractive and foreign-session events", async () => {
    const h = host(); const child = context("child", "rpc");
    for (const event of ["session_start", "agent_start", "agent_settled"]) await h.fire(event, child.ctx);
    expect(child.streamSimple).not.toHaveBeenCalled(); expect(records()).toEqual([]);
    const owner = context(); await h.fire("session_start", owner.ctx); await h.fire("agent_start", owner.ctx);
    await h.fire("agent_settled", child.ctx); expect(owner.streamSimple).not.toHaveBeenCalled(); expect(stops()).toHaveLength(0);
    await h.fire("session_shutdown", owner.ctx);
  });
});
