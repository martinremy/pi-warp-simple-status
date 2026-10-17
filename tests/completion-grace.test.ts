import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({ openSync: vi.fn(), writeSync: vi.fn(), closeSync: vi.fn() }));
vi.mock("../src/summary.js", () => ({ loadSummaryConfig: () => undefined }));
import register from "../src/index.js";

const managerKey = Symbol.for("pi-subagents:manager");
let originalManager: PropertyDescriptor | undefined;
function manager() {
  const state = { running: true, hasRunning() { return this.running; } };
  Object.defineProperty(globalThis, managerKey, { value: state, configurable: true });
  return state;
}
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
function context(id = "foreground", mode = "tui"): ExtensionContext {
  return { cwd: "/home/me/project", mode, sessionManager: { getSessionId: () => id } } as unknown as ExtensionContext;
}
function host() {
  const handlers = new Map<string, Handler>();
  const ctx = context();
  register({ on: (name: string, handler: Handler) => handlers.set(name, handler) } as unknown as ExtensionAPI);
  return { ctx, fire: async (name: string, target = ctx) => { await handlers.get(name)?.({}, target); } };
}
function records(): Array<{ event: string; session_id: string }> {
  return vi.mocked(fs.writeSync).mock.calls.map((call) => JSON.parse(String(call[1]).slice("\x1b]777;notify;warp://cli-agent;".length, -1)));
}
function stops() { return records().filter((r) => r.event === "stop"); }
async function waiting() {
  const state = manager(); const h = host();
  await h.fire("session_start"); await h.fire("agent_start"); await h.fire("agent_settled");
  return { state, h };
}

beforeEach(() => {
  originalManager = Object.getOwnPropertyDescriptor(globalThis, managerKey);
  Reflect.deleteProperty(globalThis, managerKey);
  vi.useFakeTimers();
  vi.stubEnv("TERM_PROGRAM", "WarpTerminal");
  vi.stubEnv("WARP_CLI_AGENT_PROTOCOL_VERSION", "1");
  vi.stubEnv("PI_WARP_SIMPLE_STATUS_TRACE", undefined);
  vi.mocked(fs.openSync).mockReturnValue(42);
  vi.mocked(fs.writeSync).mockReturnValue(1);
});
afterEach(() => {
  if (originalManager) Object.defineProperty(globalThis, managerKey, originalManager);
  else Reflect.deleteProperty(globalThis, managerKey);
  vi.clearAllTimers(); vi.useRealTimers(); vi.resetAllMocks(); vi.unstubAllEnvs();
});

describe("managed-work completion grace", () => {
  it.each([18, 200])("coalesces the final job and a foreground follow-up starting %i ms later", async (delay) => {
    const { state, h } = await waiting();
    state.running = false;
    await vi.advanceTimersByTimeAsync(250); // manager becomes clear
    expect(stops()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(delay);
    await h.fire("agent_start");
    await vi.advanceTimersByTimeAsync(15000);
    expect(stops()).toHaveLength(0);
    expect(records().filter((r) => r.event === "prompt_submit")).toHaveLength(2); // original start + heartbeat, no transient done/busy
    await h.fire("agent_settled");
    await vi.advanceTimersByTimeAsync(499);
    expect(stops()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(stops()).toHaveLength(1);
    expect(stops()[0]).toMatchObject({ event: "stop", session_id: "foreground" });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not require staggered jobs to finish together", async () => {
    const jobs = [{ running: true }, { running: true }];
    Object.defineProperty(globalThis, managerKey, { value: { hasRunning: () => jobs.some((job) => job.running) }, configurable: true });
    const h = host();
    await h.fire("session_start"); await h.fire("agent_start"); await h.fire("agent_settled");
    await vi.advanceTimersByTimeAsync(10000);
    jobs[0].running = false;
    await h.fire("agent_start"); await h.fire("agent_settled"); // partial-completion reply
    await vi.advanceTimersByTimeAsync(20000);
    expect(stops()).toHaveLength(0);
    jobs[1].running = false;
    await vi.advanceTimersByTimeAsync(749);
    expect(stops()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(stops()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("finishes after 500 ms of grace without follow-up, and repeated idle checks do not postpone it", async () => {
    const { state, h } = await waiting();
    state.running = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(vi.getTimerCount()).toBe(3); // heartbeat, manager poll, grace
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(100);
      await h.fire("agent_settled");
      expect(stops()).toHaveLength(0);
    }
    await vi.advanceTimersByTimeAsync(99);
    expect(stops()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(stops()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30000);
    expect(stops()).toHaveLength(1);
  });
  it("cancels grace when managed work resumes and starts fresh grace after it drains", async () => {
    const { state } = await waiting();
    state.running = false;
    await vi.advanceTimersByTimeAsync(250);
    state.running = true;
    await vi.advanceTimersByTimeAsync(250);
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(stops()).toHaveLength(0);
    state.running = false;
    await vi.advanceTimersByTimeAsync(749);
    expect(stops()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(stops()).toHaveLength(1);
  });
  it("rechecks managed work at the grace deadline before sending done", async () => {
    const { state } = await waiting();
    state.running = false;
    await vi.advanceTimersByTimeAsync(749);
    state.running = true;
    await vi.advanceTimersByTimeAsync(1);
    expect(stops()).toHaveLength(0);
    state.running = false;
    await vi.advanceTimersByTimeAsync(750);
    expect(stops()).toHaveLength(1);
  });
  it.each(["session_start", "session_shutdown"])("cleans up pending grace on %s", async (name) => {
    const { state, h } = await waiting();
    state.running = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(vi.getTimerCount()).toBe(3);
    await h.fire(name, name === "session_start" ? context("next") : h.ctx);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30000);
    expect(stops()).toHaveLength(0);
  });
  it("child events cannot cancel the foreground's grace", async () => {
    const { state, h } = await waiting(); const child = host(); const childCtx = context("child", "print");
    state.running = false;
    await vi.advanceTimersByTimeAsync(250);
    for (const name of ["session_start", "agent_start", "agent_settled", "session_shutdown"]) await child.fire(name, childCtx);
    await h.fire("agent_start", childCtx); await h.fire("session_shutdown", childCtx);
    await vi.advanceTimersByTimeAsync(500);
    expect(stops()).toHaveLength(1);
    expect(stops()[0].session_id).toBe("foreground");
  });
  it("does not debounce foreground-only completion or suppress a legitimate new turn", async () => {
    const { state, h } = await waiting();
    state.running = false;
    await vi.advanceTimersByTimeAsync(750);
    expect(stops()).toHaveLength(1);
    await h.fire("agent_start"); await h.fire("agent_settled");
    expect(stops()).toHaveLength(2); // new foreground-only run, no artificial delay
    expect(vi.getTimerCount()).toBe(0);
    Reflect.deleteProperty(globalThis, managerKey);
    await h.fire("agent_start"); await h.fire("agent_settled");
    expect(stops()).toHaveLength(3);
  });
});
