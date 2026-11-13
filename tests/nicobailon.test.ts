import * as fs from "node:fs";
import { EventEmitter } from "node:events";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({ openSync: vi.fn(), writeSync: vi.fn(), closeSync: vi.fn() }));
vi.mock("../src/summary.js", () => ({ loadSummaryConfig: () => undefined }));
import register from "../src/index.js";
import { LIVENESS_KEY } from "../src/nicobailon.js";

const LEGACY = Symbol.for("pi-subagents:manager");
const REQUEST = "subagents:rpc:v1:request";
const READY = "subagents:rpc:v1:ready";
let original: PropertyDescriptor | undefined;
let legacy: PropertyDescriptor | undefined;
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
function context(id = "parent", mode = "tui"): ExtensionContext {
  return { cwd: "/project", mode, sessionManager: { getSessionId: () => id } } as unknown as ExtensionContext;
}
function host() {
  const emitter = new EventEmitter();
  const events = {
    on(name: string, handler: (value: unknown) => void) {
      emitter.on(name, handler);
      return () => { emitter.off(name, handler); };
    },
    emit(name: string, value: unknown) { emitter.emit(name, value); },
  };
  const handlers = new Map<string, Handler>();
  register({ events, on: (name: string, handler: Handler) => handlers.set(name, handler) } as unknown as ExtensionAPI);
  return {
    events, emitter,
    fire: async (name: string, ctx = context()) => { await handlers.get(name)?.({}, ctx); },
  };
}
function provider(id: string, isActive: () => boolean) {
  const registry = Reflect.get(globalThis, LIVENESS_KEY) as {
    register(provider: { name: string; sessionId: string; isActive(): boolean }): () => void;
  };
  return registry.register({ name: "pi-subagents", sessionId: id, isActive });
}
function stops() {
  return vi.mocked(fs.writeSync).mock.calls.map(call =>
    JSON.parse(String(call[1]).slice("\x1b]777;notify;warp://cli-agent;".length, -1)) as { event: string; session_id: string },
  ).filter(value => value.event === "stop");
}
function foreignRegistry() {
  const registry = { version: 1, register: vi.fn(() => () => {}) };
  Object.defineProperty(globalThis, LIVENESS_KEY, { value: registry, configurable: true });
  return registry;
}
function rpc(h: ReturnType<typeof host>) {
  const state = { active: 2, runningWorkflow: false, fail: false, drop: false, malformed: false, delay: 0, reads: 0 };
  const ping = {
    version: 1,
    session: { sessionId: "parent" },
    capabilities: { fleetStatus: { version: 1 } },
  };
  h.events.on(REQUEST, raw => {
    const request = raw as { requestId: string; method: string };
    if (request.method === "status") state.reads++;
    const data = request.method === "ping" ? ping : {
      fleet: { version: state.malformed ? 2 : 1, totalActive: state.active, entries: [], omitted: state.active },
      asyncSnapshot: { runs: state.runningWorkflow ? [{ state: "running" }] : [] },
    };
    if (request.method === "status" && state.drop) return;
    const reply = () => h.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
      version: 1, requestId: request.requestId, success: request.method === "ping" || !state.fail, data,
    });
    if (request.method === "status" && state.delay) setTimeout(reply, state.delay);
    else reply();
  });
  return { state, ping };
}
async function start(h: ReturnType<typeof host>) {
  await h.fire("session_start");
  await h.fire("agent_start");
  await h.fire("agent_settled");
}

beforeEach(() => {
  original = Object.getOwnPropertyDescriptor(globalThis, LIVENESS_KEY);
  legacy = Object.getOwnPropertyDescriptor(globalThis, LEGACY);
  Reflect.deleteProperty(globalThis, LIVENESS_KEY);
  Reflect.deleteProperty(globalThis, LEGACY);
  vi.useFakeTimers();
  vi.stubEnv("TERM_PROGRAM", "WarpTerminal");
  vi.stubEnv("WARP_CLI_AGENT_PROTOCOL_VERSION", "1");
  vi.stubEnv("PI_WARP_SIMPLE_STATUS_TRACE", undefined);
  vi.mocked(fs.openSync).mockReturnValue(42);
  vi.mocked(fs.writeSync).mockReturnValue(1);
});
afterEach(() => {
  for (const [key, descriptor] of [[LIVENESS_KEY, original], [LEGACY, legacy]] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  vi.clearAllTimers(); vi.useRealTimers(); vi.resetAllMocks(); vi.unstubAllEnvs();
});

describe("Nico session liveness", () => {
  it.each([false, true])("captures registration before or after our session_start (before=%s)", async before => {
    const h = host();
    let active = true;
    if (before) provider("parent", () => active);
    await h.fire("session_start");
    if (!before) provider("parent", () => active);
    await h.fire("agent_start"); await h.fire("agent_settled");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(stops()).toHaveLength(0);
    active = false;
    await vi.advanceTimersByTimeAsync(750);
    expect(stops()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not announce intermediate results while a sibling continues", async () => {
    const h = host();
    let remaining = 2;
    provider("parent", () => remaining > 0);
    await start(h);
    remaining--;
    await h.fire("agent_start"); await h.fire("agent_settled");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(stops()).toHaveLength(0);
    remaining--;
    await h.fire("agent_start"); await h.fire("agent_settled");
    await vi.advanceTimersByTimeAsync(500);
    expect(stops()).toHaveLength(1);
    expect(stops()[0]).toMatchObject({ event: "stop", session_id: "parent" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("holds across result-delivery and parent-wake gaps longer than grace", async () => {
    const h = host();
    const state = { running: true, owedResult: false, delivery: false, wake: false };
    provider("parent", () => Object.values(state).some(Boolean));
    await start(h);
    state.running = false; state.owedResult = true;
    await vi.advanceTimersByTimeAsync(2_000);
    state.owedResult = false; state.delivery = true;
    await vi.advanceTimersByTimeAsync(2_000);
    state.delivery = false; state.wake = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(stops()).toHaveLength(0);
    await h.fire("agent_start");
    state.wake = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(stops()).toHaveLength(0);
    await h.fire("agent_settled");
    await vi.advanceTimersByTimeAsync(500);
    expect(stops()).toHaveLength(1);
  });

  it("ignores unrelated sessions and headless child lifecycle events", async () => {
    const h = host();
    provider("other", () => true);
    provider("parent", () => false);
    await h.fire("session_start", context("child", "print"));
    await start(h);
    expect(stops()).toHaveLength(1);
  });

  it("requires definitive false, contains provider errors, and honors release", async () => {
    const h = host();
    const release = provider("parent", () => { throw new Error("unavailable"); });
    await start(h);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(stops()).toHaveLength(0);
    release(); release();
    await vi.advanceTimersByTimeAsync(750);
    expect(stops()).toHaveLength(1);
  });

  it("releases duplicate registrations independently", async () => {
    const h = host();
    const releaseA = provider("parent", () => true);
    const releaseB = provider("parent", () => true);
    await start(h);
    releaseA();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stops()).toHaveLength(0);
    releaseB();
    await vi.advanceTimersByTimeAsync(750);
    expect(stops()).toHaveLength(1);
  });

  it("keeps legacy work blocking even when Nico is clear", async () => {
    const h = host();
    let running = true;
    Object.defineProperty(globalThis, LEGACY, { value: { hasRunning: () => running }, configurable: true });
    provider("parent", () => false);
    await start(h);
    expect(stops()).toHaveLength(0);
    running = false;
    await vi.advanceTimersByTimeAsync(750);
    expect(stops()).toHaveLength(1);
  });
});

describe("Nico public RPC fallback", () => {
  it("preserves a foreign host and uses totalActive, not bounded entries", async () => {
    const registry = foreignRegistry();
    const h = host(); const { state } = rpc(h);
    expect(Reflect.get(globalThis, LIVENESS_KEY)).toBe(registry);
    await start(h);
    expect(stops()).toHaveLength(0);
    state.active = 1;
    await h.fire("agent_start"); await h.fire("agent_settled");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(stops()).toHaveLength(0);
    state.active = 0;
    await vi.advanceTimersByTimeAsync(750);
    expect(stops()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the full liveness provider rather than an empty RPC fleet", async () => {
    const h = host(); const { state } = rpc(h);
    state.active = 0;
    let pendingWake = true;
    provider("parent", () => pendingWake);
    await start(h);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(stops()).toHaveLength(0);
    expect(state.reads).toBe(0);
    pendingWake = false;
    await vi.advanceTimersByTimeAsync(750);
    expect(stops()).toHaveLength(1);
  });

  it("keeps a running workflow busy between children", async () => {
    foreignRegistry();
    const h = host(); const { state } = rpc(h);
    state.active = 0; state.runningWorkflow = true;
    await start(h);
    expect(stops()).toHaveLength(0);
    state.runningWorkflow = false;
    await vi.advanceTimersByTimeAsync(750);
    expect(stops()).toHaveLength(1);
  });

  it("discovers late ready events but ignores another session's ready", async () => {
    foreignRegistry();
    const h = host();
    await h.fire("session_start");
    const { ping, state } = rpc(h);
    h.events.emit(READY, { ...ping, session: { sessionId: "other" } });
    await h.fire("agent_start"); await h.fire("agent_settled");
    expect(stops()).toHaveLength(1);
    h.events.emit(READY, ping);
    await h.fire("agent_start"); await h.fire("agent_settled");
    expect(stops()).toHaveLength(1);
    state.active = 0;
    await vi.advanceTimersByTimeAsync(750);
    expect(stops()).toHaveLength(2);
  });

  it("stays busy on failed or missing replies and recovers", async () => {
    foreignRegistry();
    const h = host(); const { state } = rpc(h);
    state.fail = true;
    await start(h);
    state.fail = false; state.drop = true;
    await vi.advanceTimersByTimeAsync(1_500);
    expect(stops()).toHaveLength(0);
    state.drop = false; state.active = 0;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(stops()).toHaveLength(1);
  });

  it("holds on malformed replies and rechecks work at the grace deadline", async () => {
    foreignRegistry();
    const h = host(); const { state } = rpc(h);
    state.active = 0; state.malformed = true;
    await start(h);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stops()).toHaveLength(0);
    state.malformed = false;
    await vi.advanceTimersByTimeAsync(749);
    expect(stops()).toHaveLength(0);
    state.active = 1;
    await vi.advanceTimersByTimeAsync(1);
    expect(stops()).toHaveLength(0);
    state.active = 0;
    await vi.advanceTimersByTimeAsync(750);
    expect(stops()).toHaveLength(1);
  });

  it("switches to RPC if a later host takes over the registry", async () => {
    const h = host(); const { state } = rpc(h);
    provider("parent", () => true);
    await start(h);
    foreignRegistry();
    state.active = 0;
    await vi.advanceTimersByTimeAsync(750);
    expect(stops()).toHaveLength(1);
  });

  it("coalesces slow reads and does not restart grace indefinitely", async () => {
    foreignRegistry();
    const h = host(); const { state } = rpc(h);
    await start(h);
    state.active = 0; state.delay = 400;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(stops()).toHaveLength(1);
    expect(state.reads).toBeLessThan(8);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["session_start", "session_shutdown", "agent_start"])("ignores in-flight results after %s", async event => {
    foreignRegistry();
    const h = host(); const { state } = rpc(h);
    await start(h);
    state.active = 0; state.delay = 400;
    await vi.advanceTimersByTimeAsync(250);
    await h.fire(event, event === "session_start" ? context("next") : context());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(stops()).toHaveLength(0);
    if (event === "session_shutdown") {
      expect(h.emitter.listenerCount(READY)).toBe(0);
      expect(h.emitter.eventNames().filter(name => String(name).includes(":reply:"))).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("does not reuse an old idle projection for a new run that launched work", async () => {
    foreignRegistry();
    const h = host(); const { state } = rpc(h);
    await start(h);
    state.active = 0; state.delay = 400;
    await vi.advanceTimersByTimeAsync(250); // previous run's idle read in flight
    await h.fire("agent_start");
    state.active = 1;
    const settled = h.fire("agent_settled");
    await vi.advanceTimersByTimeAsync(1_500);
    await settled;
    expect(stops()).toHaveLength(0);
    state.active = 0;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(stops()).toHaveLength(1);
  });

  it("keeps ordinary completion immediate when no implementation responds", async () => {
    const h = host();
    await start(h);
    expect(stops()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(stops()).toHaveLength(1);
    await h.fire("session_shutdown");
    expect(vi.getTimerCount()).toBe(0);
    expect(h.emitter.eventNames()).toHaveLength(0);
  });
});
