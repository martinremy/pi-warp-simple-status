import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { supportsWarp, writeStatus, type StatusEvent, type WarpSession } from "./warp.js";
import { hasManagedWork } from "./subagents.js";
import { createTrace } from "./trace.js";

const HEARTBEAT_MS = 15_000;
const WORK_CHECK_MS = 250;

export default function register(pi: ExtensionAPI): void {
  // Each runtime owns its own identity and timer. In-process SDK children may
  // import this same module, but cannot affect the foreground instance.
  let session: WarpSession | undefined;
  let busy = false;
  let foregroundActive = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let workCheck: ReturnType<typeof setInterval> | undefined;
  let lastManagedWork: boolean | undefined;

  const trace = createTrace(() => ({
    ownerSessionId: session?.id ?? null,
    busy,
    foregroundActive,
    heartbeatActive: heartbeat !== undefined,
    workCheckActive: workCheck !== undefined,
  }));
  const warpSupported = supportsWarp();
  trace("registration", "detect_warp", () => ({ warpSupported }));
  if (!warpSupported) return;

  function traceLifecycle(event: string, ctx: ExtensionContext): void {
    trace("lifecycle", event, () => ({ sessionId: ctx.sessionManager.getSessionId(), mode: ctx.mode }));
  }

  function emit(event: StatusEvent, active: WarpSession, reason: string): void {
    trace("emit", event, () => ({ sessionId: active.id, reason }));
    writeStatus(event, active);
  }

  function stopHeartbeat(): void {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    heartbeat = undefined;
  }

  function stopWorkCheck(): void {
    if (workCheck !== undefined) clearInterval(workCheck);
    workCheck = undefined;
  }

  function finishWhenIdle(active: WarpSession, reason: "agent_settled" | "manager_poll"): void {
    if (!busy || foregroundActive || session !== active) return;
    const managedWorkBlocking = hasManagedWork();
    if (lastManagedWork !== managedWorkBlocking) {
      lastManagedWork = managedWorkBlocking;
      trace("manager", "work_status", () => ({ sessionId: active.id, managedWorkBlocking }));
    }
    if (managedWorkBlocking) {
      if (workCheck === undefined) {
        workCheck = setInterval(() => finishWhenIdle(active, "manager_poll"), WORK_CHECK_MS);
        workCheck.unref();
      }
      return;
    }
    busy = false;
    stopHeartbeat();
    stopWorkCheck();
    emit("stop", active, reason);
  }

  function owns(ctx: ExtensionContext): boolean {
    return ctx.mode === "tui" && session !== undefined
      && ctx.sessionManager.getSessionId() === session.id;
  }

  pi.on("session_start", (_event, ctx) => {
    traceLifecycle("session_start", ctx);
    if (ctx.mode !== "tui") return;
    const id = ctx.sessionManager.getSessionId();
    if (session?.id === id && session.cwd === ctx.cwd) return;
    stopHeartbeat();
    stopWorkCheck();
    busy = false;
    foregroundActive = false;
    lastManagedWork = undefined;
    session = { id, cwd: ctx.cwd };
    emit("session_start", session, "session_start");
  });

  pi.on("agent_start", (_event, ctx) => {
    traceLifecycle("agent_start", ctx);
    if (!owns(ctx)) return;
    foregroundActive = true;
    stopWorkCheck();
    if (busy) return;
    const active = session!;
    busy = true;
    lastManagedWork = undefined;
    emit("prompt_submit", active, "agent_start");
    heartbeat = setInterval(() => {
      if (busy && session === active) emit("prompt_submit", active, "heartbeat");
    }, HEARTBEAT_MS);
    heartbeat.unref();
  });

  // agent_end can be followed by retry, compaction, or queued continuation.
  // Settlement ends the foreground run, but managed background work can remain.
  pi.on("agent_settled", (_event, ctx) => {
    traceLifecycle("agent_settled", ctx);
    if (!owns(ctx) || !busy) return;
    foregroundActive = false;
    finishWhenIdle(session!, "agent_settled");
  });

  pi.on("session_shutdown", (_event, ctx) => {
    traceLifecycle("session_shutdown", ctx);
    if (!owns(ctx)) return;
    busy = false;
    foregroundActive = false;
    stopHeartbeat();
    stopWorkCheck();
    lastManagedWork = undefined;
    session = undefined;
  });
}
