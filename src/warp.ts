import { closeSync, openSync, writeSync } from "node:fs";
import { basename } from "node:path";

export interface WarpSession {
  readonly id: string;
  readonly cwd: string;
}

export type StatusEvent = "session_start" | "prompt_submit" | "stop";

export function supportsWarp(): boolean {
  const version = Number(process.env.WARP_CLI_AGENT_PROTOCOL_VERSION);
  return process.env.TERM_PROGRAM === "WarpTerminal"
    && Number.isSafeInteger(version) && version >= 1;
}

/** Best-effort terminal transport. Never send conversation content to Warp. */
export function writeStatus(event: StatusEvent, session: WarpSession): void {
  if (!supportsWarp()) return;
  const payload = {
    v: 1,
    agent: "pi",
    event,
    session_id: session.id,
    cwd: session.cwd,
    project: basename(session.cwd),
    ...(event === "prompt_submit" ? { query: "" } : {}),
    ...(event === "stop" ? { query: "", response: "Pi finished responding." } : {}),
  };
  const bytes = `\x1b]777;notify;warp://cli-agent;${JSON.stringify(payload)}\x07`;
  if (process.platform === "win32") {
    try {
      // Avoid asynchronous stream errors escaping this best-effort boundary.
      if (process.stdout.isTTY) writeSync(process.stdout.fd, bytes);
    } catch {
      // A notification must never interrupt Pi.
    }
    return;
  }

  let fd: number | undefined;
  try {
    fd = openSync("/dev/tty", "w");
    writeSync(fd, bytes);
  } catch {
    // No controlling terminal, or a failed write: remain silent.
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort cleanup */ }
    }
  }
}
