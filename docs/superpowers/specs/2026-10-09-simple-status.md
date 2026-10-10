# pi-warp-simple-status — initial 0.1.0 design

Historical approved design. Completion semantics were subsequently broadened in
[Optional manager-wide completion](2026-10-09-managed-completion.md).

## Outcome
Create public GitHub repository `martinremy/pi-warp-simple-status` (matching pi-recap's visibility), clone it to `/Users/mremy/devhome/github/pi-warp-simple-status`, and implement a standalone Pi extension. Leave rpiv-mono and the user's installed extension/settings untouched.

Done means the foreground assistant has finished responding. Background subagents may still be running; their events must never change this extension's terminal status or produce completion notifications.

## Repository conventions
Follow pi-recap: ESM package, `src/index.ts` Pi entry point, no runtime build, MIT license copyright 2026 Martin Remy, its Node-oriented .gitignore, and a concise README with Install, Usage, Behavior notes, and Development. Add automated tests and a TypeScript check. No npm publication or automatic installation. Commit and push the implementation to main after verification.

## Foreground identification and lifecycle
Require the current Pi extension API, including `ctx.mode` and `agent_settled` (develop/test against Pi 1.1.0). Terminal output is enabled only in Warp with structured protocol support and `ctx.mode === "tui"`; RPC/print/JSON/SDK children are excluded even if UI APIs exist. Capture the interactive session ID on session_start. Keep all mutable state inside each extension factory, never at module scope. Check mode and captured session ID on every event and timer callback.

- session_start: stop any prior heartbeat, capture the new interactive session identity, emit Warp session_start once for that session. Rebind correctly on /new, /resume, /fork, and reload.
- agent_start: for the captured foreground session only, mark busy and emit prompt_submit. Start one 15-second heartbeat repeating prompt_submit while busy. No tools or commands registered.
- agent_settled: for a matching active foreground run only, mark not busy, cancel heartbeat, and emit stop once. Never use agent_end to indicate completion; settlement is after Pi's automatic continuation/retry/compaction work. Duplicate settlement must not emit twice.
- session_shutdown: idempotent timer cleanup, without a completion notification.

The shutdown cleanup is a fourth handler, not a fourth user-facing status event. Timer callbacks use captured plain session metadata and check that it still matches the owned active session. Timers are unref'd.

## Warp transport and payloads
Use Warp OSC 777 `notify;warp://cli-agent` with protocol version 1, agent `pi`, session ID, cwd, and project basename. Only three wire event types: session_start, prompt_submit, stop. Use empty query for busy/heartbeat and a generic completion response (`Pi finished responding.`) for stop; do not capture or transmit conversation content. Serialize JSON to keep terminal control characters escaped.

On macOS/Linux, write best-effort to /dev/tty and always close opened descriptors; no process-wide stdout interception. On Windows, use TTY stdout as a best-effort fallback. No emission outside Warp or without a positive structured-protocol version. Transport failure must not interrupt Pi. No rpiv dependencies, version-channel blacklist, custom title spinner, idle timer, question notifications, or child-work aggregation.

Warp decides actual badges/toasts according to its implementation, focus, and OS permissions; protocol writes are not proof of displayed toasts. Retain the heartbeat because the existing integration uses it to keep long tasks busy. Verify this mapping live before declaring visual behavior proven.

## Verification
Tests must exercise registered lifecycle handlers and inspect decoded outgoing terminal bytes, including:
- foreground startup -> busy -> settled -> done;
- agent_end alone does not emit stop;
- child/headless/RPC events do not emit or mutate foreground state;
- two concurrently registered extension instances remain isolated;
- heartbeat survives internal agent_end, stops at settlement/shutdown, never duplicates, and cannot emit for a replaced session;
- session switch/reload identity handling;
- duplicate settlement, transport failure, non-Warp/missing protocol, and valid JSON wire framing.

Run the complete new repo test suite, TypeScript checking, packaging inspection, and a Pi loader smoke test. Report automated evidence separately from live Warp badge/toast verification. Do not claim visual success without observation by the user.

## Boundaries and remaining live check
Do not change rpiv-mono, pi-recap, or user Pi settings. Do not install both notification extensions together. After automated verification, provide replacement install commands and ask the user to observe busy/done/toast behavior for a normal foreground turn, a long turn, and a background-subagent launch. If stop does not produce the intended toast or status, gather transport/visual evidence before altering the minimal event mapping.
