import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

interface TraceState {
  ownerSessionId: string | null;
  busy: boolean;
  foregroundActive: boolean;
  heartbeatActive: boolean;
  workCheckActive: boolean;
  completionPending: boolean;
  hadManagedWork: boolean;
}
interface TraceDetails {
  sessionId?: string;
  mode?: ExtensionContext["mode"];
  reason?: string;
  managedWorkBlocking?: boolean;
  warpSupported?: boolean;
}

/** Metadata-only, best-effort diagnostics; details are lazy when disabled. */
export function createTrace(state: () => TraceState) {
  let instanceId: string | undefined;
  return (
    kind: "registration" | "lifecycle" | "manager" | "completion" | "emit" | "summary",
    event: string,
    details: () => TraceDetails = () => ({}),
  ): void => {
    const path = process.env.PI_WARP_SIMPLE_STATUS_TRACE;
    if (!path) return;
    try {
      instanceId ??= randomUUID();
      const record = {
        timestamp: new Date().toISOString(),
        pid: process.pid,
        instanceId,
        kind,
        event,
        ...state(),
        ...details(),
      };
      appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
      // Diagnostics, including context inspection failures, must not affect Pi.
    }
  };
}
