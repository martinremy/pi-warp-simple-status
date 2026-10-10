import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { supportsWarp, writeStatus, type WarpSession } from "./warp.js";
import { hasManagedWork } from "./subagents.js";

const HEARTBEAT_MS = 15_000;
const WORK_CHECK_MS = 250;

export default function register(pi: ExtensionAPI): void {
  if (!supportsWarp()) return;

  // Each runtime owns its own identity and timer. In-process SDK children may
  // import this same module, but cannot affect the foreground instance.
  let session: WarpSession | undefined;
  let busy = false;
  let foregroundActive = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let workCheck: ReturnType<typeof setInterval> | undefined;

  function stopHeartbeat(): void {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    heartbeat = undefined;
  }

  function stopWorkCheck(): void {
    if (workCheck !== undefined) clearInterval(workCheck);
    workCheck = undefined;
  }

  function finishWhenIdle(active: WarpSession): void {
    if (!busy || foregroundActive || session !== active) return;
    if (hasManagedWork()) {
      if (workCheck === undefined) {
        workCheck = setInterval(() => finishWhenIdle(active), WORK_CHECK_MS);
        workCheck.unref();
      }
      return;
    }
    busy = false;
    stopHeartbeat();
    stopWorkCheck();
    writeStatus("stop", active);
  }

  function owns(ctx: ExtensionContext): boolean {
    return ctx.mode === "tui" && session !== undefined
      && ctx.sessionManager.getSessionId() === session.id;
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const id = ctx.sessionManager.getSessionId();
    if (session?.id === id && session.cwd === ctx.cwd) return;
    stopHeartbeat();
    stopWorkCheck();
    busy = false;
    foregroundActive = false;
    session = { id, cwd: ctx.cwd };
    writeStatus("session_start", session);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!owns(ctx)) return;
    foregroundActive = true;
    stopWorkCheck();
    if (busy) return;
    const active = session!;
    busy = true;
    writeStatus("prompt_submit", active);
    heartbeat = setInterval(() => {
      if (busy && session === active) writeStatus("prompt_submit", active);
    }, HEARTBEAT_MS);
    heartbeat.unref();
  });

  // agent_end can be followed by retry, compaction, or queued continuation.
  // Settlement ends the foreground run, but managed background work can remain.
  pi.on("agent_settled", (_event, ctx) => {
    if (!owns(ctx) || !busy) return;
    foregroundActive = false;
    finishWhenIdle(session!);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (!owns(ctx)) return;
    busy = false;
    foregroundActive = false;
    stopHeartbeat();
    stopWorkCheck();
    session = undefined;
  });
}
