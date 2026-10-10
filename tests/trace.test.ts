import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async () => ({
  ...await vi.importActual<typeof import("node:fs")>("node:fs"),
  openSync: vi.fn(), writeSync: vi.fn(), closeSync: vi.fn(),
}));
import register from "../src/index.js";

const managerKey = Symbol.for("pi-subagents:manager");
let originalManager: PropertyDescriptor | undefined;
let dir: string;
let path: string;
function manager(running: boolean) {
  const state = { running, hasRunning() { return this.running; } };
  Object.defineProperty(globalThis, managerKey, { value: state, configurable: true });
  return state;
}
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
function host() {
  const handlers = new Map<string, Handler>();
  register({ on: (name: string, handler: Handler) => handlers.set(name, handler) } as unknown as ExtensionAPI);
  return { fire: async (name: string, ctx: ExtensionContext, event: unknown = {}) => { await handlers.get(name)?.(event, ctx); } };
}
function context(id = "foreground", mode = "tui"): ExtensionContext {
  return { cwd: "/home/me/project", mode, sessionManager: { getSessionId: () => id }, prompt: "PRIVATE PROMPT", response: "PRIVATE REPLY" } as unknown as ExtensionContext;
}
function bytes(): string[] { return vi.mocked(fs.writeSync).mock.calls.map((call) => String(call[1])); }
function traceRecords(): Array<Record<string, unknown>> {
  return fs.readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), "pi-warp-simple-trace-"));
  path = join(dir, "trace.jsonl");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-10T01:00:00Z"));
  vi.stubEnv("TERM_PROGRAM", "WarpTerminal");
  vi.stubEnv("WARP_CLI_AGENT_PROTOCOL_VERSION", "1");
  vi.stubEnv("PI_WARP_SIMPLE_STATUS_TRACE", path);
  vi.mocked(fs.openSync).mockReturnValue(42);
  vi.mocked(fs.writeSync).mockReturnValue(1);
  originalManager = Object.getOwnPropertyDescriptor(globalThis, managerKey);
  Reflect.deleteProperty(globalThis, managerKey);
});
afterEach(() => {
  if (originalManager) Object.defineProperty(globalThis, managerKey, originalManager);
  else Reflect.deleteProperty(globalThis, managerKey);
  vi.clearAllTimers(); vi.useRealTimers(); vi.resetAllMocks(); vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("opt-in diagnostic trace", () => {
  it("writes real JSONL showing cancelled grace and one stop after a completion follow-up", async () => {
    const state = manager(true); const h = host(); const ctx = context();
    await h.fire("session_start", ctx);
    await h.fire("agent_start", ctx, { prompt: "PRIVATE EVENT", input: "PRIVATE INPUT" });
    await h.fire("agent_settled", ctx);
    await vi.advanceTimersByTimeAsync(15000);
    state.running = false;
    await vi.advanceTimersByTimeAsync(250); // manager clear starts grace
    await vi.advanceTimersByTimeAsync(200); // completion notification arrives later
    await h.fire("agent_start", ctx);
    await h.fire("agent_settled", ctx);
    await vi.advanceTimersByTimeAsync(500); // one stop after follow-up settles
    const raw = fs.readFileSync(path, "utf8");
    const records = traceRecords();
    const stops = records.filter((r) => r.kind === "emit" && r.event === "stop");
    expect(stops.map((r) => r.reason)).toEqual(["completion_grace"]);
    expect(records).toContainEqual(expect.objectContaining({ kind: "completion", event: "cancelled", reason: "agent_start" }));
    expect(stops.every((r) => r.sessionId === "foreground" && r.ownerSessionId === "foreground" && r.pid === process.pid)).toBe(true);
    expect(new Set(records.map((r) => r.instanceId)).size).toBe(1);
    expect(records).toContainEqual(expect.objectContaining({ kind: "manager", event: "work_status", managedWorkBlocking: true }));
    expect(records).toContainEqual(expect.objectContaining({ kind: "manager", event: "work_status", managedWorkBlocking: false }));
    expect(records).toContainEqual(expect.objectContaining({ kind: "lifecycle", event: "agent_settled", mode: "tui" }));
    expect(records).toContainEqual(expect.objectContaining({ kind: "emit", event: "prompt_submit", reason: "heartbeat" }));
    expect(bytes().filter((b) => b.includes('"event":"stop"'))).toHaveLength(1);
    expect(records.every((r) => !Number.isNaN(Date.parse(String(r.timestamp))))).toBe(true);
    expect(raw).not.toContain("PRIVATE");
    if (process.platform !== "win32") expect(fs.statSync(path).mode & 0o777).toBe(0o600);
  });
  it("does not create a file with tracing disabled", async () => {
    vi.stubEnv("PI_WARP_SIMPLE_STATUS_TRACE", undefined);
    const h = host(); const ctx = context();
    await h.fire("session_start", ctx); await h.fire("agent_start", ctx); await h.fire("agent_settled", ctx);
    expect(fs.existsSync(path)).toBe(false);
    expect(bytes().filter((b) => b.includes('"event":"stop"'))).toHaveLength(1);
  });
  it.each([undefined, "enabled"])("contains diagnostic context inspection errors with trace %s", async (enabled) => {
    vi.stubEnv("PI_WARP_SIMPLE_STATUS_TRACE", enabled ? path : undefined);
    const h = host();
    const ignoredChild = { mode: "print" } as ExtensionContext; // intentionally cannot provide a session ID
    await expect(h.fire("agent_start", ignoredChild)).resolves.toBeUndefined();
    expect(bytes()).toEqual([]);
  });
  it.each(["enabled", "unwritable"])("preserves emitted bytes and timer decisions when trace is %s", async (destination) => {
    const run = async () => {
      const state = manager(true); const h = host(); const ctx = context();
      await h.fire("session_start", ctx); await h.fire("agent_start", ctx); await h.fire("agent_settled", ctx);
      expect(vi.getTimerCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(15000);
      state.running = false;
      await vi.advanceTimersByTimeAsync(750);
      await h.fire("session_shutdown", ctx);
      expect(vi.getTimerCount()).toBe(0);
    };
    vi.stubEnv("PI_WARP_SIMPLE_STATUS_TRACE", undefined);
    await run(); const untraced = bytes();
    vi.mocked(fs.writeSync).mockClear();
    vi.stubEnv("PI_WARP_SIMPLE_STATUS_TRACE", destination === "enabled" ? path : "/dev/null/trace.jsonl");
    await run();
    expect(bytes()).toEqual(untraced);
  });
  it("distinguishes child and foreground instances without leaking child emissions", async () => {
    const parent = host(); const child = host(); const ctx = context(); const childCtx = context("child", "print");
    await parent.fire("session_start", ctx); await parent.fire("agent_start", ctx);
    await child.fire("session_start", childCtx); await child.fire("agent_start", childCtx); await child.fire("agent_settled", childCtx);
    await parent.fire("agent_settled", ctx);
    const records = traceRecords();
    expect(new Set(records.map((r) => r.instanceId)).size).toBe(2);
    expect(records).toContainEqual(expect.objectContaining({ kind: "lifecycle", event: "agent_start", sessionId: "child", mode: "print", busy: false }));
    expect(records.filter((r) => r.kind === "emit").every((r) => r.sessionId === "foreground")).toBe(true);
  });
});
