# Pi Warp Simple Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for native execution, or superpowers:subagent-driven-development if the user selects that method. Track the steps below.

**Goal:** Create and publish the standalone foreground-only Warp busy/done Pi extension in `martinremy/pi-warp-simple-status`.

**Architecture:** One Pi factory owns session identity, busy state, and one heartbeat. A small stateless transport handles Warp detection, protocol-1 JSON payloads, and best-effort terminal writes. Tests exercise factory handlers, timers, and actual encoded transport output at the OS boundary.

**Tech Stack:** TypeScript, Node.js built-ins, Pi 1.1.0 API, Vitest fake timers, TypeScript checking. No runtime third-party dependencies.

**Spec:** `/tmp/pi-warp-simple-status-design.md` (copy into the new repo's `docs/superpowers/specs/` during setup).

## Global Constraints
- Public GitHub repo `martinremy/pi-warp-simple-status`; checkout `/Users/mremy/devhome/github/pi-warp-simple-status`.
- Follow pi-recap's ESM/`src/index.ts` layout, LICENSE, .gitignore, and README style.
- Require Pi >=1.1.0; foreground guard uses `ctx.mode === "tui"` plus captured session identity.
- Only session_start, prompt_submit, and stop wire events; completion is foreground response settlement, not completion of background work.
- Heartbeat 15000 ms, unref'd; stop response `Pi finished responding.`, busy query empty; no conversation text.
- No mutable module-global state, no custom spinner, no idle timer, no question notifications, no child aggregation.
- Do not alter rpiv-mono, pi-recap, or user Pi settings; do not install/publish npm automatically.
- Commit/push verified implementation to main. Report live Warp verification separately.

## Review Focus
- SDK/RPC contexts may have UI: tests must exclude every mode except tui.
- Session changes invalidate old timer metadata: tests must prove old callbacks cannot emit after /new or resume.
- Multiple factory registrations share a module: concurrent parent/child tests must prove no state interference.
- Abort or duplicate settlement: test that active run gets one stop and heartbeat cleanup without agent_end-driven completion.
- Terminal failures and unavailable protocol: tests must prove safe no-op behavior and descriptor cleanup.

## File responsibilities
- `src/index.ts`: default `register(pi: ExtensionAPI): void`; registration-local ownership and lifecycle state.
- `src/warp.ts`: `supportsWarp(): boolean`, `writeStatus(event: "session_start" | "prompt_submit" | "stop", session: { id: string; cwd: string }): void`; protocol framing and transport, no shared state.
- `tests/status.test.ts`: minimal Pi handler harness, lifecycle and fake-timer behavior, decoded emitted OSC bytes (mock only OS write/open boundary).
- `tests/warp.test.ts`: environment validation, JSON framing and OS failure cleanup.
- `package.json`, `package-lock.json`, `tsconfig.json`: Pi package metadata and repeatable dev checks.
- `README.md`, `LICENSE`, `.gitignore`: user documentation and pi-recap-derived conventions.
- `docs/superpowers/specs/2026-10-09-simple-status.md`, `docs/superpowers/plans/2026-10-09-simple-status.md`: approved spec and plan.

### Task 1: Create repo and implement stateless Warp transport
- [ ] Create empty public repo via `gh repo create martinremy/pi-warp-simple-status --public`; clone to the requested path. Use the fresh clone as isolated workspace; inspect any AGENTS.md before working.
- [ ] Copy pi-recap LICENSE/.gitignore exactly; copy approved spec/plan into docs. Add ESM package manifest with Pi entry, MIT license/repo fields, Pi >=1.1.0 peer, pinned dev dependencies, `test` and `check` scripts, explicit distributable files; add strict no-emit TypeScript config.
- [ ] Write tests first: Warp with positive integer protocol accepts version 1; non-Warp/missing/invalid protocol rejects; payload contains v=1, agent=pi, event/id/cwd/project and event-specific generic text; embedded control chars stay JSON-escaped; /dev/tty descriptor always closes; open/write/close failures never escape; Windows output only with TTY stdout.
- [ ] Run tests and observe missing implementation failures. Implement only `supportsWarp` and `writeStatus` in src/warp.ts, using Node fs and path built-ins. Run transport tests to green.
- [ ] Commit repository scaffolding, approved docs, transport and tests.

### Task 2: Implement foreground lifecycle and heartbeat
- [ ] Add handler-harness tests before implementation. Literal expected wire event sequence: session_start, prompt_submit, stop. No stop on agent_end. No events on child/RPC/print/JSON sessions, even with hasUI true. Parent keeps heartbeat after child start/end/shutdown.
- [ ] Add fake-timer tests: 15000 ms emits one busy heartbeat; settlement cancels it; no duplicate heartbeat after repeated starts; duplicate settlement and idle settlement emit nothing; shutdown clears state without toast; session_start replacement cancels old heartbeat and correctly owns the new ID; wrong session/mode cannot stop the owned run; two registrations remain independent. Assert decoded OS-boundary terminal writes, not test-only production observation lists.
- [ ] Run lifecycle tests to expected failure. Implement default factory in src/index.ts with session_start, agent_start, agent_settled, session_shutdown only. Keep identity/busy/timer inside factory. Capture plain session metadata in guarded heartbeat callback. Never inspect conversation content.
- [ ] Run all tests and TypeScript check; commit lifecycle implementation and tests.

### Task 3: Documentation, independent review, verification and push
- [ ] Write README following pi-recap's structure. Explain foreground busy/done semantics, heartbeat, headless exclusion, generic text, required Pi/Warp support, OS/focus dependence, no visual verification yet, no simultaneous rpiv-warp install, local/git install and exact-source uninstall commands, test/check commands.
- [ ] Run complete `npm test`, `npm run check`, `npm pack --dry-run`, and a no-model Pi resource-loader smoke test proving this package resolves/registers without errors. Delegate long local runs to background_runner.
- [ ] Obtain one independent read-only reviewer against actual diff/spec. Address concrete findings, rerun affected/full checks if code changes. Do not equate loader/encoded-byte tests with observed Warp toasts.
- [ ] Commit final documentation/review changes. Push main and verify GitHub remote SHA matches local HEAD; report repository URL, checkout path, checks and install steps. Do not change user settings or claim busy/done rendering verified without user observation.

## Execution handoff
The user approved this plan and native execution. Implemented in the fresh requested checkout on main; the checkpoints above are the original approved task list.

## Execution record
- Repo created and cloned at the requested path; pi-recap license and gitignore copied unchanged.
- Transport/lifecycle tests were observed failing before implementation, then passing.
- Independent final review identified a Windows asynchronous stdout failure path. Replaced it with synchronous TTY-fd writes; two transport checks failed before the correction and passed afterward.
- Final full suite: 40 passing tests in 2 files. TypeScript check passed.
- Pi 1.1.0 loader smoke passed: four lifecycle handlers, no tools or commands.
- npm pack dry-run passed: package manifest, README, LICENSE, and two source files only.
- No correctness blockers remain from review. Visual Warp badge/toast behavior, heartbeat expiry, and coexistence with Pi's built-in terminal status remain live-verification boundaries, not automated success claims.
- Ruling: use the fresh main checkout rather than a linked worktree, per the approved initial-repo plan. Existing repositories and user Pi settings were left unchanged.
- Initial publication is an authorized push to main; no npm release or automatic installation.
