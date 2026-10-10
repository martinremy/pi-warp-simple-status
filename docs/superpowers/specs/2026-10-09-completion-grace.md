# Managed-work completion grace (0.1.3)

User approved local option 2: do not modify pi-subagents and do not rely on individual agents finishing together.

## Runtime evidence
The live 0.1.2 trace showed a foreground `stop` from manager polling at 2026-10-10T01:44:43.056Z, then a foreground `agent_start` 18 ms later to handle a subagent-completion notification. Child print-mode instances emitted no Warp status. This establishes an extra completion-cycle mechanism, not proof that every emission became a toast.

## Approved behavior
- Add 500 ms of cancellable grace only after a busy period actually observed blocking managed work. Ordinary foreground-only completion remains immediate.
- Keep the 15-second busy heartbeat and 250 ms manager polling alive during grace.
- New foreground work cancels grace and postpones completion until foreground settlement. Preserve the managed-work history across that follow-up, so its settlement can start fresh grace.
- Managed work becoming blocking again cancels grace; once clear again, start a fresh window. The grace callback rechecks foreground state, manager status, and session ownership before emitting.
- Repeated idle polls or duplicate settlement do not reset an existing grace timer.
- Clear all three timers on completion, session replacement, and shutdown. Timers are unref'd; all state remains registration-local.
- Do not deduplicate completed busy periods by a blanket cooldown: a legitimate new foreground-only turn gets its own immediate completion.
- Tracing adds completion scheduled/cancelled/elapsed records, completionPending/hadManagedWork state, and completion_grace stop reason. No conversation content or third-party changes.

## Limits
This is a bounded delivery-latency workaround, not an authoritative pending-notification API. Follow-ups delayed beyond the window can still create a separate busy/done cycle. Work that was never observed as blocking does not trigger grace. Manager access remains optional and safely contained as before.

## Verification
New tests replay 18 ms and 200 ms follow-ups, stagger two managed completions 20 seconds apart, prove non-resetting deadlines, resumption/rechecks, child isolation, cleanup, and no suppression of legitimate new turns. Eight assertions failed against 0.1.2; all ten new tests pass after implementation. Existing timing expectations were adjusted to include managed-work grace. The full suite is 77 passing tests, with TypeScript clean.

A subsequent live run of the local code logged completion scheduled at 2026-10-10T03:41:33.065Z and cancelled by foreground start at 03:41:33.107Z (42 ms later), with no intervening stop. Final visible toast count still requires the user's observation after the foreground response settles.
