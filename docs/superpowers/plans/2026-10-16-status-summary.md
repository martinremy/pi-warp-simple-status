# Status Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optionally summarize Pi's latest completed turn in a 5–8-word Warp completion response, falling back to the existing static response.

**Architecture:** Keep the existing completion gate, polling, and grace logic. A separate summary module reads global configuration, extracts bounded text from the session branch, and calls a configured Pi model. A cancellable pending attempt delays only the final `stop` emission and cannot complete a newer turn.

**Tech Stack:** TypeScript, Node 22+, Pi model registry/auth and pi-ai completion API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-16-status-summary-design.md` (records the approved chat design and explicitly labeled implementation defaults).

## Global Constraints

- Requires Pi 1.2.0 or newer (subsequently approved by the user).
- Configuration: `<agent-dir>/warp-simple-status.json`, respecting Pi's agent directory.
- Resolve the configured provider/model using Pi's registry and credentials; no separate secrets.
- No configuration means current static behavior.
- Generation starts only at the existing definitive completion point; no speculative generation or new grace policy.
- Summary: 5–8 words, maximum 160 characters; input maximum 12000 characters; default timeout 10000 ms.
- Fallback: `Pi finished responding.`; one model attempt, no output-repair retries.
- Preserve non-TUI exclusion, session ownership, managed-work semantics, and best-effort terminal transport.
- No edits to the user's Pi configuration, no network model calls in automated tests, no publishing or pushing.

## Review Focus

- An auth/provider promise never settles or ignores abort: deadline still emits fallback and clears timers (Task 1/2).
- A new turn begins in the same session during generation: the old result cannot stop that turn or its heartbeat (Task 2).
- Managed work resumes while generation is pending: no premature `stop`; existing gating remains authoritative (Task 2).
- Latest branch ends in tool/error/thinking-only messages: never summarize an earlier turn as current success (Task 1).
- Opt-in summaries disclose conversation-derived content to Warp/provider: document this and keep tracing metadata-only (Task 2).

---

### Task 1: Configuration, bounded input, and model adapter

**Files:** Create `src/summary.ts`, `tests/summary.test.ts`; modify `package.json`/`package-lock.json` only if a direct pi-ai peer declaration is required by the verified import contract.

**Interfaces:**
- Consumes: `ExtensionContext.sessionManager`, `ExtensionContext.modelRegistry`, Pi's agent-directory resolver, and direct pi-ai completion API (confirm exact installed signatures before code).
- Produces: `SummaryConfig { provider: string; model: string; timeoutMs: number }`; `loadSummaryConfig(): SummaryConfig | undefined`; `summarizeTurn(ctx: ExtensionContext, config: SummaryConfig, signal: AbortSignal): Promise<string | undefined>`.
- `undefined` means use the static fallback; unexpected failures must remain contained. The whole attempt has a deadline, including auth, independent of whether the underlying request honors cancellation.

- [x] **Step 1: Write failing unit tests.** Use temporary config directories and mock Pi/model calls. Assert absent/unreadable/malformed config disables generation; positive integer timeout defaults to 10000; invalid provider/model/timeout shapes are rejected. Assert latest user request plus final assistant text only, 12000-character bound, no previous-turn fallback, no thinking/tool data. Assert a valid six-word result is returned; fewer than five or more than eight words, controls, empty text, or >160 characters return `undefined`. Assert registry/auth/provider failures return `undefined`, timeout aborts a hanging request and returns `undefined` even if the provider ignores abort, external cancellation cleans timeout, and no model tools are supplied.
- [x] **Step 2: Run red tests.** `npm test -- tests/summary.test.ts` must fail for the missing summary implementation, not an unrelated test setup failure.
- [x] **Step 3: Implement the module.** Use the verified installed Pi APIs. Read global config once per registration through `loadSummaryConfig`; snapshot branch text synchronously before async auth. Use a direct bounded model request, explicitly instructing faithful outcome wording and treating source text as data. Race the full request against timeout/cancellation with cleanup on every exit. Do not inject conversation messages or catch-and-log sensitive provider errors.
- [x] **Step 4: Run green tests and type check.** `npm test -- tests/summary.test.ts` and `npm run check` must pass. Confirm failure tests exercise the actual completion result, not test-only observations.

### Task 2: Attach summaries after the existing completion gate

**Files:** Modify `src/index.ts`, `src/warp.ts`, `README.md`, `tests/status.test.ts`, `tests/warp.test.ts`; create `tests/status-summary.test.ts`; extend metadata-only `src/trace.ts`/`tests/trace.test.ts` only if needed.

**Interfaces:**
- Consumes Task 1's `loadSummaryConfig` and `summarizeTurn`.
- Produces: `writeStatus(event: StatusEvent, session: WarpSession, response?: string): void`, preserving the exact static default and empty query. Non-stop events never include a response.
- The registration owns one optional attempt identity, AbortController, gate-readiness flag, and retained result. Managed-work checks remain active during generation; resumed work renews the existing grace but does not trigger a second model request. `finishWhenIdle` retains its existing checks and grace scheduling; its final emission path starts generation only if configured. A successful pending result must still own the session and turn and pass the existing work gate before emission.

- [x] **Step 1: Write failing integration and wire tests.** Inspect real encoded `fs.writeSync` payloads. Assert configured summaries appear in one `stop`; no configuration retains exact current behavior. With deferred model promises, assert no call before foreground settlement or managed-work clearance plus 500 ms grace, exactly one call for repeated settlement/polls, heartbeat until completion, exact static fallback after timeout, and no leaked timers. Assert same-session new start, session replacement, and shutdown abort/invalidate old attempts; resolve the obsolete provider promise afterward and assert it cannot emit or cancel new timers. Assert non-TUI/foreign-session events do not generate. Assert resumed managed work blocks emission and existing gate permits one eventual completion. Update the status handler-list assertion only if event capture is actually needed; prefer branch snapshot extraction to avoid extra lifecycle handlers.
- [x] **Step 2: Run red tests.** `npm test -- tests/status-summary.test.ts tests/warp.test.ts` must fail on absent dynamic response/lifecycle behavior.
- [x] **Step 3: Implement the narrow integration.** Load configuration after the Warp guard. Retain the current definitive completion path when unconfigured. Start a non-blocking pending summary from its final emission point when configured, retain heartbeat, deduplicate attempts, and abort/invalidate on the existing new-work/session/shutdown boundaries. Guard callback ownership with a per-attempt identity, not session ID alone. Reuse existing work gating rather than inventing a second timing system. Keep summary content out of traces.
- [x] **Step 4: Update README.** Document example global file, Pi registry/auth reuse, reload behavior, 10000 ms default timeout, fallback, no-config compatibility, provider/Warp privacy implications, and intentionally post-gate generation. Remove claims that the extension never calls a model or never sends any conversation-derived content. Do not claim live toast/model verification.
- [x] **Step 5: Run full verification.** `npm test`, `npm run check`, `git diff --check`; inspect exact diff for no changes to settlement/grace constants or manager adapter. Run these through `background_runner` if long-running, per local instructions. Obtain one fresh whole-change code review; address confirmed findings and rerun affected tests plus the full suite/check.

## Execution handoff

Two small, tightly coupled tasks; Native execution is recommended to avoid repeated implementation contexts, with one independent final review. No user global config is written until separately requested. Changes remain on `status-summary`; committing or pushing is not required for this implementation.
