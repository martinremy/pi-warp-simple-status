import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// pi-subagents 0.88.0's host-liveness contract. It includes owed results,
// completion delivery and parent wakes, unlike the public fleet projection.
export const LIVENESS_KEY = Symbol.for("@agegr/pi-web/session-liveness/v1");
const PROVIDERS_KEY = Symbol.for("pi-warp-simple-status:liveness-providers:v1");
const REQUEST = "subagents:rpc:v1:request";
const READY = "subagents:rpc:v1:ready";
const RPC_TIMEOUT_MS = 1_000;
interface Provider {
  name: string;
  sessionId: string;
  isActive(): boolean;
}
interface HostRegistry {
  version: 1;
  register(provider: Provider): () => void;
  [PROVIDERS_KEY]: Set<Provider>;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function installLivenessHost(): void {
  try {
    // Never replace a host owned by another integration (e.g. pi-web).
    if (Reflect.get(globalThis, LIVENESS_KEY) !== undefined) return;
    const providers = new Set<Provider>();
    const registry: HostRegistry = {
      version: 1,
      [PROVIDERS_KEY]: providers,
      register(provider) {
        if (!provider || typeof provider.name !== "string" || typeof provider.sessionId !== "string"
          || typeof provider.isActive !== "function") throw new TypeError("Invalid liveness provider");
        // Separate registrations remain independently releasable.
        const entry = { name: provider.name, sessionId: provider.sessionId, isActive: () => provider.isActive() };
        providers.add(entry);
        return () => { providers.delete(entry); };
      },
    };
    Object.defineProperty(globalThis, LIVENESS_KEY, { value: registry, configurable: true, writable: true });
  } catch { /* A locked/foreign registry is handled through RPC instead. */ }
}

function liveness(sessionId: string): boolean | undefined {
  try {
    const registry = Reflect.get(globalThis, LIVENESS_KEY);
    if (!record(registry)) return undefined;
    const providers: unknown = Reflect.get(registry, PROVIDERS_KEY);
    if (!(providers instanceof Set)) return undefined;
    let found = false;
    for (const provider of providers as Set<Provider>) {
      if (provider.name !== "pi-subagents" || provider.sessionId !== sessionId) continue;
      found = true;
      if (provider.isActive() !== false) return true;
    }
    return found ? false : undefined;
  } catch { return true; }
}

/** Session-scoped, optional adapter. No package imports or disk inspection. */
export function createNicoAdapter(pi: ExtensionAPI) {
  // Install before *any* session_start handler: either extension load order
  // then lets pi-subagents register its provider during session_start.
  installLivenessHost();
  let sessionId: string | undefined;
  let generation = 0;
  let available = false;
  let offReady: (() => void) | undefined;
  const pending = new Set<() => void>();
  let statusRead: Promise<boolean> | undefined;

  function request(method: "ping" | "status"): Promise<unknown> {
    const events = pi.events;
    if (!events) return Promise.resolve(undefined);
    return new Promise(resolve => {
      const requestId = randomUUID();
      let off: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let finished = false;
      const finish = (value?: unknown) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        off?.();
        pending.delete(cancel);
        resolve(value);
      };
      const cancel = () => finish();
      pending.add(cancel);
      try {
        off = events.on(`subagents:rpc:v1:reply:${requestId}`, value => {
          if (!record(value) || value.version !== 1 || value.requestId !== requestId) return;
          finish(value.success === true ? value.data : undefined);
        });
        timer = setTimeout(cancel, RPC_TIMEOUT_MS);
        timer.unref();
        events.emit(REQUEST, { version: 1, requestId, method, params: {} });
      } catch { finish(); }
    });
  }

  function acceptPing(value: unknown): void {
    if (!record(value) || value.version !== 1 || !record(value.session)
      || value.session.sessionId !== sessionId || !record(value.capabilities)) return;
    const fleet = value.capabilities.fleetStatus;
    if (record(fleet) && fleet.version === 1) available = true;
  }

  function stop(): void {
    generation++;
    sessionId = undefined;
    available = false;
    offReady?.();
    offReady = undefined;
    for (const cancel of [...pending]) cancel();
    statusRead = undefined;
  }

  return {
    start(id: string): void {
      stop();
      sessionId = id;
      if (!pi.events) return;
      const current = generation;
      offReady = pi.events.on(READY, acceptPing);
      void request("ping").then(value => {
        if (generation === current) acceptPing(value);
      });
    },
    stop,
    foregroundStarted(): void {
      // A new run may launch new work before a previous read replies. Never
      // reuse that old projection for the new run's completion decision.
      statusRead = undefined;
    },
    hasWork(id: string): boolean | Promise<boolean> {
      const live = liveness(id);
      if (live !== undefined) return live;
      if (id !== sessionId || !available) return false;
      if (!statusRead) {
        const current = generation;
        const read = request("status").then(value => {
          if (generation !== current) return true; // caller also checks ownership
          if (!record(value) || !record(value.fleet) || value.fleet.version !== 1
            || !Number.isSafeInteger(value.fleet.totalActive) || (value.fleet.totalActive as number) < 0) return true;
          if ((value.fleet.totalActive as number) > 0) return true;
          // A workflow can still own scheduling between individual children.
          const snapshot = value.asyncSnapshot;
          return record(snapshot) && Array.isArray(snapshot.runs)
            && snapshot.runs.some(run => record(run) && (run.state === "running" || run.state === "queued"));
        }).catch(() => true);
        statusRead = read;
        void read.finally(() => { if (statusRead === read) statusRead = undefined; });
      }
      return statusRead;
    },
  };
}
