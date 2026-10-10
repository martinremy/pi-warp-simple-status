// Documented cross-package registry in @tintinweb/pi-subagents 0.20.0.
// No import/dependency: the package may be absent or register after we load.
const MANAGER_KEY = Symbol.for("pi-subagents:manager");

export function hasManagedWork(): boolean {
  try {
    const manager: unknown = Reflect.get(globalThis, MANAGER_KEY);
    if (manager === null || (typeof manager !== "object" && typeof manager !== "function")) return false;
    const hasRunning: unknown = Reflect.get(manager, "hasRunning");
    if (typeof hasRunning !== "function") return false;
    // The contract is synchronous boolean. Only a definitive false permits
    // completion; unexpected values or inspection errors keep us busy.
    return hasRunning.call(manager) !== false;
  } catch {
    return true;
  }
}
