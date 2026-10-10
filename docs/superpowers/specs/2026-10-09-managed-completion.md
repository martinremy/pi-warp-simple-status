# Optional manager-wide completion (0.1.1)

Approved change to the initial foreground-only design:

- Warp stays busy until the foreground response has settled AND the optional `pi-subagents` manager has no running/queued work.
- Read the documented `globalThis[Symbol.for("pi-subagents:manager")].hasRunning()` capability dynamically. No package import or runtime dependency. Absence/non-callable capability falls back to foreground-only completion; access/call errors are contained and conservatively treated as busy until a later check succeeds.
- After foreground settlement, recheck managed work every 250 ms while continuing the 15-second busy heartbeat. Stop both timers at completion, session replacement, and shutdown.
- Manager-wide deliberately includes nested agents, workflows, and work retained across session switches. It does not independently detect jobs started while the extension is idle.
- A foreground restart while waiting cancels the idle-status checker, keeps the busy heartbeat, and prevents completion until that foreground run settles again.
- Emit only the existing session_start/prompt_submit/stop wire events, under the foreground session identity. Child instances cannot emit or interfere with the foreground state.
- No lifecycle-event counting or tool-output parsing: cancellation/failure/queued transitions are reflected by the authoritative manager predicate.

Verification: missing/non-callable registry, two jobs running/queued, queued cancellation without events, callable method binding, manager registered late, duplicate settlement, foreground restart, child-instance isolation, session/shutdown cleanup, registry/call exceptions with recovery, and manager disappearance. Tests inspect actual decoded OS-boundary terminal writes. Visual correctness remains a separate live check after reload/restart.

Execution: new managed-work suite failed 11 assertions against 0.1.0 (premature stop). Adapter and lifecycle change made the full suite pass 55 tests, with TypeScript clean. Independent review found no blockers; its suggested safety coverage (throwing method getter and nonboolean results) was added, bringing the final suite to 60 passing tests. Pi 1.1.0 loader smoke without a subagent registry and package dry-run passed. Live Warp behavior still requires confirmation after reload/restart.
