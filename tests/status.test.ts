import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({ openSync: vi.fn(), writeSync: vi.fn(), closeSync: vi.fn() }));
vi.mock("../src/summary.js", () => ({ loadSummaryConfig: () => undefined }));
import register from "../src/index.js";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
function host() {
  const handlers = new Map<string, Handler>();
  const pi = { on: (name: string, handler: Handler) => { handlers.set(name, handler); } } as unknown as ExtensionAPI;
  register(pi);
  return {
    handlers,
    fire: async (name: string, ctx: ExtensionContext, event: unknown = {}) => {
      await handlers.get(name)?.(event, ctx);
    },
  };
}
function context(id = "foreground", mode = "tui", hasUI = true): ExtensionContext {
  return { cwd: "/home/me/project", mode, hasUI, sessionManager: { getSessionId: () => id } } as unknown as ExtensionContext;
}
function records(): Array<{ event: string; session_id: string; query?: string; response?: string }> {
  return vi.mocked(fs.writeSync).mock.calls.map((call) => JSON.parse(String(call[1]).slice("\x1b]777;notify;warp://cli-agent;".length, -1)));
}
function events(): string[] { return records().map((record) => record.event); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("TERM_PROGRAM", "WarpTerminal");
  vi.stubEnv("WARP_CLI_AGENT_PROTOCOL_VERSION", "1");
  vi.stubEnv("PI_WARP_SIMPLE_STATUS_TRACE", undefined);
  vi.mocked(fs.openSync).mockReturnValue(42);
  vi.mocked(fs.writeSync).mockReturnValue(1);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.resetAllMocks(); vi.unstubAllEnvs(); });

describe("foreground status", () => {
  it("announces, marks busy, and completes exactly once on settlement", async () => {
    const h = host(); const ctx = context();
    expect([...h.handlers.keys()].sort()).toEqual(["agent_settled", "agent_start", "session_shutdown", "session_start"]);
    await h.fire("session_start", ctx);
    await h.fire("agent_start", ctx);
    await h.fire("agent_end", ctx);
    expect(events()).toEqual(["session_start", "prompt_submit"]);
    await h.fire("agent_settled", ctx);
    await h.fire("agent_settled", ctx);
    await vi.advanceTimersByTimeAsync(30000);
    expect(events()).toEqual(["session_start", "prompt_submit", "stop"]);
    expect(records()[2]).toMatchObject({ session_id: "foreground", response: "Pi finished responding." });
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["rpc", "json", "print", undefined])("ignores non-terminal mode %s even with UI", async (mode) => {
    const h = host(); const ctx = context("child", "rpc");
    Object.assign(ctx, { mode });
    for (const name of ["session_start", "agent_start", "agent_settled", "session_shutdown"]) await h.fire(name, ctx);
    await vi.advanceTimersByTimeAsync(30000);
    expect(records()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("ignores events without an owned session", async () => {
    const h = host();
    await h.fire("agent_start", context()); await h.fire("agent_settled", context());
    expect(records()).toEqual([]);
  });
  it("stays silent on idle startup and announces only once when work starts", async () => {
    const h = host(); const ctx = context();
    await h.fire("session_start", ctx); await h.fire("session_start", ctx);
    await h.fire("agent_settled", ctx);
    await vi.advanceTimersByTimeAsync(30000);
    expect(records()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    await h.fire("agent_start", ctx); await h.fire("agent_settled", ctx);
    await h.fire("session_start", ctx);
    await h.fire("agent_start", ctx); await h.fire("agent_settled", ctx);
    expect(events()).toEqual(["session_start", "prompt_submit", "stop", "prompt_submit", "stop"]);
  });
  it("stays silent across idle session replacement and announces only the session that starts work", async () => {
    const h = host(); const oldCtx = context("old"); const nextCtx = context("next");
    await h.fire("session_start", oldCtx);
    await h.fire("session_shutdown", oldCtx);
    await h.fire("session_start", nextCtx, { reason: "new" });
    await h.fire("agent_start", oldCtx);
    await vi.advanceTimersByTimeAsync(30000);
    expect(records()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    await h.fire("agent_start", nextCtx);
    expect(records().map((r) => [r.event, r.session_id])).toEqual([["session_start", "next"], ["prompt_submit", "next"]]);
  });
  it("keeps heartbeat alive across agent_end until settlement", async () => {
    const h = host(); const ctx = context();
    await h.fire("session_start", ctx); await h.fire("agent_start", ctx); await h.fire("agent_end", ctx);
    await vi.advanceTimersByTimeAsync(14999);
    expect(events()).toEqual(["session_start", "prompt_submit"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(events()).toEqual(["session_start", "prompt_submit", "prompt_submit"]);
    expect(records()[2]).toMatchObject({ session_id: "foreground", query: "" });
    await h.fire("agent_settled", ctx, { aborted: true });
    await vi.advanceTimersByTimeAsync(30000);
    expect(events()).toEqual(["session_start", "prompt_submit", "prompt_submit", "stop"]);
  });
  it("does not create duplicate timers for repeated starts", async () => {
    const h = host(); const ctx = context();
    await h.fire("session_start", ctx); await h.fire("agent_start", ctx); await h.fire("agent_start", ctx);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(15000);
    expect(events()).toEqual(["session_start", "prompt_submit", "prompt_submit"]);
  });
  it("ignores idle settlement and cleans up without a shutdown toast", async () => {
    const h = host(); const ctx = context();
    await h.fire("session_start", ctx); await h.fire("agent_settled", ctx);
    await h.fire("agent_start", ctx); await h.fire("session_shutdown", ctx); await h.fire("session_shutdown", ctx);
    await h.fire("agent_settled", ctx); await vi.advanceTimersByTimeAsync(30000);
    expect(events()).toEqual(["session_start", "prompt_submit"]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("foreign-session events cannot stop or replace the foreground heartbeat", async () => {
    const h = host(); const ctx = context(); const child = context("child", "rpc", false);
    await h.fire("session_start", ctx); await h.fire("agent_start", ctx);
    for (const name of ["session_start", "agent_start", "agent_settled", "session_shutdown"]) await h.fire(name, child);
    await h.fire("agent_settled", context("foreign"));
    await h.fire("session_shutdown", context("foreign"));
    await vi.advanceTimersByTimeAsync(15000);
    expect(events()).toEqual(["session_start", "prompt_submit", "prompt_submit"]);
    expect(records().every((record) => record.session_id === "foreground")).toBe(true);
  });
  it("concurrent parent and child registrations remain isolated", async () => {
    const parent = host(); const child = host(); const parentCtx = context(); const childCtx = context("child", "rpc", false);
    await parent.fire("session_start", parentCtx); await parent.fire("agent_start", parentCtx);
    await child.fire("session_start", childCtx); await child.fire("agent_start", childCtx);
    await child.fire("agent_settled", childCtx); await child.fire("session_shutdown", childCtx);
    await vi.advanceTimersByTimeAsync(15000);
    expect(events()).toEqual(["session_start", "prompt_submit", "prompt_submit"]);
    await parent.fire("agent_settled", parentCtx);
    expect(events()).toEqual(["session_start", "prompt_submit", "prompt_submit", "stop"]);
  });
  it("two interactive registrations own independent timers", async () => {
    const a = host(); const b = host(); const aCtx = context("a"); const bCtx = context("b");
    await a.fire("session_start", aCtx); await a.fire("agent_start", aCtx);
    await b.fire("session_start", bCtx); await b.fire("agent_start", bCtx);
    await a.fire("agent_settled", aCtx);
    await vi.advanceTimersByTimeAsync(15000);
    expect(records().filter((r) => r.event === "prompt_submit").map((r) => r.session_id)).toEqual(["a", "b", "b"]);
  });
  it.each(["new", "resume", "fork", "reload"])("rebinds on %s and cancels stale-session timers", async (reason) => {
    const h = host(); const oldCtx = context("old"); const nextCtx = context("next");
    await h.fire("session_start", oldCtx); await h.fire("agent_start", oldCtx);
    await vi.advanceTimersByTimeAsync(10000);
    await h.fire("session_start", nextCtx, { reason });
    await h.fire("agent_settled", oldCtx); await h.fire("session_shutdown", oldCtx);
    await vi.advanceTimersByTimeAsync(30000);
    expect(events()).toEqual(["session_start", "prompt_submit"]);
    await h.fire("agent_start", nextCtx); await vi.advanceTimersByTimeAsync(15000); await h.fire("agent_settled", nextCtx);
    expect(records().slice(2).map((r) => [r.event, r.session_id])).toEqual([["session_start", "next"], ["prompt_submit", "next"], ["prompt_submit", "next"], ["stop", "next"]]);
  });
  it("registers nothing outside supported Warp", () => {
    vi.stubEnv("TERM_PROGRAM", "OtherTerminal");
    expect(host().handlers.size).toBe(0);
  });
});
