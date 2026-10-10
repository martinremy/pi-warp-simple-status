import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({ openSync: vi.fn(), writeSync: vi.fn(), closeSync: vi.fn() }));
import register from "../src/index.js";

const managerKey = Symbol.for("pi-subagents:manager");
let originalManager: PropertyDescriptor | undefined;
function setManager(manager: unknown): void {
  Object.defineProperty(globalThis, managerKey, { value: manager, configurable: true, writable: true });
}
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
function host() {
  const handlers = new Map<string, Handler>();
  register({ on: (name: string, handler: Handler) => handlers.set(name, handler) } as unknown as ExtensionAPI);
  return { fire: async (name: string, ctx: ExtensionContext) => { await handlers.get(name)?.({}, ctx); } };
}
function context(id = "foreground", mode = "tui"): ExtensionContext {
  return { cwd: "/home/me/project", mode, sessionManager: { getSessionId: () => id } } as unknown as ExtensionContext;
}
function records(): Array<{ event: string; session_id: string }> {
  return vi.mocked(fs.writeSync).mock.calls.map((call) => JSON.parse(String(call[1]).slice("\x1b]777;notify;warp://cli-agent;".length, -1)));
}
function events(): string[] { return records().map((r) => r.event); }

beforeEach(() => {
  originalManager = Object.getOwnPropertyDescriptor(globalThis, managerKey);
  Reflect.deleteProperty(globalThis, managerKey);
  vi.useFakeTimers();
  vi.stubEnv("TERM_PROGRAM", "WarpTerminal");
  vi.stubEnv("WARP_CLI_AGENT_PROTOCOL_VERSION", "1");
  vi.mocked(fs.openSync).mockReturnValue(42);
  vi.mocked(fs.writeSync).mockReturnValue(1);
});
afterEach(() => {
  if (originalManager) Object.defineProperty(globalThis, managerKey, originalManager);
  else Reflect.deleteProperty(globalThis, managerKey);
  vi.clearAllTimers(); vi.useRealTimers(); vi.resetAllMocks(); vi.unstubAllEnvs();
});

describe("optional manager-wide completion", () => {
  it.each([undefined, null, {}, { hasRunning: "not a function" }])("falls back safely with unavailable manager %j", async (manager) => {
    setManager(manager);
    const h = host(); const ctx = context();
    await h.fire("session_start", ctx); await h.fire("agent_start", ctx); await h.fire("agent_settled", ctx);
    await vi.advanceTimersByTimeAsync(30000);
    expect(events()).toEqual(["session_start", "prompt_submit", "stop"]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not emit done while either of two managed jobs is running or queued", async () => {
    const jobs = [{ status: "running" }, { status: "queued" }];
    setManager({ hasRunning: () => jobs.some((job) => job.status === "running" || job.status === "queued") });
    const h = host(); const ctx = context();
    await h.fire("session_start", ctx); await h.fire("agent_start", ctx); await h.fire("agent_settled", ctx);
    expect(events()).toEqual(["session_start", "prompt_submit"]);
    await vi.advanceTimersByTimeAsync(15000);
    expect(events()).toEqual(["session_start", "prompt_submit", "prompt_submit"]);
    jobs[0].status = "completed";
    await vi.advanceTimersByTimeAsync(250);
    expect(events()).not.toContain("stop");
    jobs[1].status = "stopped"; // queued cancellation: no lifecycle event
    await vi.advanceTimersByTimeAsync(249);
    expect(events()).not.toContain("stop");
    await vi.advanceTimersByTimeAsync(1);
    expect(events()).toEqual(["session_start", "prompt_submit", "prompt_submit", "stop"]);
    expect(records().every((r) => r.session_id === "foreground")).toBe(true);
    await h.fire("agent_settled", ctx); await vi.advanceTimersByTimeAsync(30000);
    expect(events().filter((event) => event === "stop")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("binds hasRunning to its manager object", async () => {
    const manager = { running: true, hasRunning() { return this.running; } };
    setManager(manager);
    const h = host(); const ctx = context();
    await h.fire("session_start", ctx); await h.fire("agent_start", ctx); await h.fire("agent_settled", ctx);
    expect(events()).not.toContain("stop");
    manager.running = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(events()).toEqual(["session_start", "prompt_submit", "stop"]);
  });
  it("discovers a manager registered after this extension loads", async () => {
    const h = host(); const ctx = context();
    await h.fire("session_start", ctx); await h.fire("agent_start", ctx);
    const manager = { hasRunning: () => true };
    setManager(manager);
    await h.fire("agent_settled", ctx);
    expect(events()).not.toContain("stop");
    manager.hasRunning = () => false;
    await vi.advanceTimersByTimeAsync(250);
    expect(events()).toEqual(["session_start", "prompt_submit", "stop"]);
  });
  it("keeps waiting if duplicate settlement arrives during managed work", async () => {
    let running = true;
    setManager({ hasRunning: () => running });
    const h = host(); const ctx = context();
    await h.fire("session_start", ctx); await h.fire("agent_start", ctx);
    await h.fire("agent_settled", ctx); await h.fire("agent_settled", ctx);
    expect(vi.getTimerCount()).toBe(2);
    expect(events()).not.toContain("stop");
    running = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(events()).toEqual(["session_start", "prompt_submit", "stop"]);
  });
  it("does not complete when jobs finish during a new foreground response", async () => {
    let running = true;
    setManager({ hasRunning: () => running });
    const h = host(); const ctx = context();
    await h.fire("session_start", ctx); await h.fire("agent_start", ctx); await h.fire("agent_settled", ctx);
    await h.fire("agent_start", ctx);
    running = false;
    await vi.advanceTimersByTimeAsync(15000);
    expect(events()).toEqual(["session_start", "prompt_submit", "prompt_submit"]);
    expect(vi.getTimerCount()).toBe(1);
    await h.fire("agent_settled", ctx);
    expect(events()).toEqual(["session_start", "prompt_submit", "prompt_submit", "stop"]);
  });
  it.each(["session_start", "session_shutdown"])("cancels managed polling and heartbeat on %s", async (name) => {
    let running = true;
    setManager({ hasRunning: () => running });
    const h = host(); const ctx = context();
    await h.fire("session_start", ctx); await h.fire("agent_start", ctx); await h.fire("agent_settled", ctx);
    expect(vi.getTimerCount()).toBe(2);
    await h.fire(name, name === "session_start" ? context("next") : ctx);
    expect(vi.getTimerCount()).toBe(0);
    running = false;
    await vi.advanceTimersByTimeAsync(30000);
    expect(events()).not.toContain("stop");
  });
  it("child events cannot bypass managed-work waiting", async () => {
    let running = true;
    setManager({ hasRunning: () => running });
    const parent = host(); const child = host(); const ctx = context(); const childCtx = context("child", "print");
    await parent.fire("session_start", ctx); await parent.fire("agent_start", ctx); await parent.fire("agent_settled", ctx);
    for (const name of ["session_start", "agent_start", "agent_settled", "session_shutdown"]) await child.fire(name, childCtx);
    await parent.fire("agent_settled", childCtx); await parent.fire("session_shutdown", childCtx);
    await vi.advanceTimersByTimeAsync(250);
    expect(events()).toEqual(["session_start", "prompt_submit"]);
    running = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(events()).toEqual(["session_start", "prompt_submit", "stop"]);
  });
  it("contains status-call exceptions, stays busy, and retries", async () => {
    const manager = { hasRunning: () => { throw new Error("temporarily unavailable"); } } as { hasRunning: () => boolean };
    setManager(manager);
    const h = host(); const ctx = context();
    await h.fire("session_start", ctx); await h.fire("agent_start", ctx);
    await expect(h.fire("agent_settled", ctx)).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(15000);
    expect(events()).toEqual(["session_start", "prompt_submit", "prompt_submit"]);
    manager.hasRunning = () => false;
    await vi.advanceTimersByTimeAsync(250);
    expect(events()).toEqual(["session_start", "prompt_submit", "prompt_submit", "stop"]);
  });
  it("contains registry-access errors until the registry recovers", async () => {
    Object.defineProperty(globalThis, managerKey, { configurable: true, get: () => { throw new Error("registry unavailable"); } });
    const h = host(); const ctx = context();
    await h.fire("session_start", ctx); await h.fire("agent_start", ctx);
    await expect(h.fire("agent_settled", ctx)).resolves.toBeUndefined();
    expect(events()).not.toContain("stop");
    setManager({ hasRunning: () => false });
    await vi.advanceTimersByTimeAsync(250);
    expect(events()).toEqual(["session_start", "prompt_submit", "stop"]);
  });
  it("contains a throwing method getter until it recovers", async () => {
    setManager({ get hasRunning() { throw new Error("method unavailable"); } });
    const h = host(); const ctx = context();
    await h.fire("session_start", ctx); await h.fire("agent_start", ctx);
    await expect(h.fire("agent_settled", ctx)).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(250);
    expect(events()).not.toContain("stop");
    setManager({ hasRunning: () => false });
    await vi.advanceTimersByTimeAsync(250);
    expect(events()).toEqual(["session_start", "prompt_submit", "stop"]);
  });
  it.each([undefined, null, 0, "false"])("requires definitive false after unexpected status %j", async (result) => {
    setManager({ hasRunning: () => result });
    const h = host(); const ctx = context();
    await h.fire("session_start", ctx); await h.fire("agent_start", ctx); await h.fire("agent_settled", ctx);
    await vi.advanceTimersByTimeAsync(250);
    expect(events()).not.toContain("stop");
    setManager({ hasRunning: () => false });
    await vi.advanceTimersByTimeAsync(250);
    expect(events()).toEqual(["session_start", "prompt_submit", "stop"]);
  });
  it("falls back safely if the manager is removed while waiting", async () => {
    setManager({ hasRunning: () => true });
    const h = host(); const ctx = context();
    await h.fire("session_start", ctx); await h.fire("agent_start", ctx); await h.fire("agent_settled", ctx);
    expect(events()).not.toContain("stop");
    Reflect.deleteProperty(globalThis, managerKey);
    await vi.advanceTimersByTimeAsync(250);
    expect(events()).toEqual(["session_start", "prompt_submit", "stop"]);
  });
});
