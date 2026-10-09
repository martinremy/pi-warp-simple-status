import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { supportsWarp, writeStatus, type WarpSession } from "./warp.js";

const HEARTBEAT_MS = 15_000;

export default function register(pi: ExtensionAPI): void {
  if (!supportsWarp()) return;

  // Each runtime owns its own identity and timer. In-process SDK children may
  // import this same module, but cannot affect the foreground instance.
  let session: WarpSession | undefined;
  let busy = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  function stopHeartbeat(): void {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    heartbeat = undefined;
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
    busy = false;
    session = { id, cwd: ctx.cwd };
    writeStatus("session_start", session);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!owns(ctx) || busy) return;
    const active = session!;
    busy = true;
    writeStatus("prompt_submit", active);
    heartbeat = setInterval(() => {
      if (busy && session === active) writeStatus("prompt_submit", active);
    }, HEARTBEAT_MS);
    heartbeat.unref();
  });

  // agent_end can be followed by retry, compaction, or queued continuation.
  // Settlement is the final notification-only boundary for this foreground run.
  pi.on("agent_settled", (_event, ctx) => {
    if (!owns(ctx) || !busy) return;
    busy = false;
    stopHeartbeat();
    writeStatus("stop", session!);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (!owns(ctx)) return;
    busy = false;
    stopHeartbeat();
    session = undefined;
  });
}
