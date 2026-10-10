# pi-warp-simple-status

Busy and done status for [Pi](https://pi.dev) in [Warp](https://www.warp.dev), with optional subagent-aware completion. Warp stays busy while the foreground assistant is working and, when `@tintinweb/pi-subagents` is available, while its manager still has running or queued work. Done is sent only after the foreground response has settled and that managed work has cleared.

A deliberately smaller alternative to `rpiv-warp`: no child-session notifications, question events, idle timer, or custom tab-title spinner.

## Install

Requires **Pi 1.1.0 or newer** and a Warp build that advertises structured CLI-agent protocol support. Clone the repo, then point `pi install` at the checkout:

```sh
git clone https://github.com/martinremy/pi-warp-simple-status.git
pi install /path/to/pi-warp-simple-status
```

This installs globally (into `~/.pi/agent/settings.json`). Add `-l` to install into the current project instead. Uninstall using the same source you installed:

```sh
pi remove /path/to/pi-warp-simple-status
```

If you don't need a local checkout:

```sh
pi install git:github.com/martinremy/pi-warp-simple-status
# To uninstall:
pi remove git:github.com/martinremy/pi-warp-simple-status
```

**Remove or disable `rpiv-warp` and other Warp status extensions first.** Running two integrations can produce conflicting badges and duplicate toasts. Restart Pi after switching extensions.

## Usage

Start Pi inside Warp and use it normally. No commands, arguments, or configuration.

| Pi lifecycle | Sent to Warp |
| --- | --- |
| Interactive session starts or switches, before any work | Nothing — track the session internally |
| First foreground agent run in that session starts | `session_start`, then `prompt_submit` — announce and mark busy |
| Subsequent foreground agent runs start | `prompt_submit` — busy |
| Foreground agent settles, and managed work is clear | `stop` — done |

A busy heartbeat repeats every 15 seconds while waiting for either the foreground response or managed work to finish. After foreground settlement, managed status is checked every 250 ms. Once observed managed work drains, completion gets a cancellable **500 ms grace period** so its notification can start a foreground follow-up without an extra done/busy cycle. The heartbeat stays active during grace; completion, session replacement, and shutdown clear all timers. There is no delayed `idle_prompt` event.

## Behavior notes

- **No Warp indicator is introduced before the first prompt.** Warp's `session_start` announcement is deferred until actual foreground work begins, because announcing an idle session produces a busy indicator. Startup and idle session switches emit no status, and do not send a fake completion to clear the badge. Switching sessions does not explicitly clear an indicator left by earlier work.
- **Done means the foreground response has settled and no running or queued work remains in the optional subagent manager.** Launching background agents no longer produces completion just because the foreground reply ends.
- The `pi-subagents` check is **manager-wide**: nested agents, workflows, and work retained across a session switch can hold completion. It is not filtered to the current turn or session. This extension does not independently announce jobs started while it is idle; it checks managed work when a foreground run settles.
- `@tintinweb/pi-subagents` is **optional** and is not imported or installed by this extension. If its registry or callable status method is absent, completion is foreground-only. The documented registry API was checked against version 0.20.0 and is looked up dynamically, avoiding extension load-order dependence.
- Status-check exceptions are contained. An installed manager that throws or reports an unexpected result is treated as busy, and checks continue until it reports `false`. If the registry is removed, the extension returns to foreground-only behavior.
- Only interactive terminal sessions (`ctx.mode === "tui"`) are eligible. Events must also match the session ID captured by that extension instance. RPC, JSON, print, and headless child sessions are ignored.
- Uses `agent_settled`, not `agent_end`: the latter can precede retries, compaction, and automatic continuation. If another foreground response starts while waiting for background work or during completion grace, completion also waits for that response to settle. Each continuous busy period sends completion once.
- Grace applies only to a busy period that observed blocking managed work; ordinary foreground-only completion remains immediate. New foreground or managed work cancels pending completion, and both conditions are checked again when grace expires. Repeated idle checks do not postpone the timer.
- The grace window starts when the whole manager clears, not whenever an individual agent finishes, so staggered completions are supported. It is a bounded workaround for notification delivery latency, **not a guarantee against arbitrarily delayed follow-ups**. No `pi-subagents` changes or blanket suppression of legitimate new turns are involved.
- State and heartbeat timers are owned by each extension instance. A child instance cannot cancel the foreground instance's heartbeat.
- Does not change Pi's own spinner or terminal title, register model tools, or call a model.
- Sends project directory and session identity, but **no prompt, reply, question, or tool-input content**. Completion text is simply “Pi finished responding.”
- Outside Warp or without a positive structured-protocol version, it does nothing. Terminal writes are best-effort; an unavailable terminal cannot interrupt Pi.
- macOS/Linux write OSC 777 to `/dev/tty`. Windows uses TTY stdout as a best-effort fallback.
- **Warp controls badge appearance and OS toasts**, including focus behavior, notification permissions, and Do Not Disturb. Sending `stop` does not guarantee a visible toast. The wire mapping is covered by automated tests; live busy/done rendering and toast behavior still require confirmation in Warp.

## Diagnostic tracing

To investigate duplicate toasts, exit Pi and start it with an opt-in JSONL path:

```sh
PI_WARP_SIMPLE_STATUS_TRACE=/tmp/pi-warp-simple-status-trace.jsonl pi --resume
```

The parent directory must exist. Tracing is off by default and does not change
notification rules. It appends metadata only: timestamp, PID, extension-instance
ID, event session ID, owned foreground session ID, mode, busy/foreground state,
and timer state. No conversation content is logged.

- `kind: "lifecycle"` observes `session_start`, `agent_start`, `agent_settled`,
  or `session_shutdown`. Child events can appear here without sending status.
- `kind: "manager"` records transitions in `managedWorkBlocking`, the safe
  adapter's result. `true` includes throwing/invalid status checks treated
  conservatively as busy; `false` includes an absent optional manager.
- `kind: "emit"` records an attempted OSC 777 event. For `stop`, `reason` is
  `completion_grace` after managed-work grace, or `agent_settled` for immediate
  foreground-only completion. The deferred `session_start` announcement has
  reason `agent_start`; it is emitted immediately before the first busy event
  in that session. Busy events distinguish `agent_start` from `heartbeat`.
- `kind: "completion"` records grace being `scheduled`, `cancelled`, or
  `elapsed`. `completionPending` and `hadManagedWork` appear in state snapshots.

Two `emit/stop` records mean this extension attempted two completion events.
One such record does not rule out another notification source, such as Pi's
built-in terminal status reporting. An emission record does not prove transport
success or a displayed toast.

File-write/inspection failures are swallowed. New files use mode `0600` on
platforms that honor it; existing permissions are not tightened. Synchronous
logging can affect timing, so use a normal local file and unset the variable
when the capture is complete. The old `RPIV_WARP_TRACE` variable is not used.

## Development

The Pi entry point is [`src/index.ts`](src/index.ts); the stateless Warp transport lives in [`src/warp.ts`](src/warp.ts), and the optional manager adapter in [`src/subagents.ts`](src/subagents.ts). Pi loads TypeScript directly via jiti—no runtime build step or third-party runtime dependency.

```sh
npm ci
npm test
npm run check
```

Tests inspect encoded terminal writes and exercise silent idle startup and session replacement, first-run announcement ordering and deduplication, foreground/headless separation, heartbeat ownership, session changes, settlement, optional/missing manager behavior, managed-job completion/cancellation, completion grace and delayed follow-up deduplication, safe status-call failures, and transport failure cleanup. After editing, restart Pi or use `/reload` to pick up changes.

For a live check, use only this integration. Launch a fresh empty session without sending a prompt and confirm no indicator appears; run `/new` before the first prompt and confirm it remains silent. Send a first prompt and confirm busy/done behavior starts normally. Then observe a normal foreground turn, a turn lasting more than 15 seconds, and two background agents waiting for 45 seconds. With `pi-subagents` available, the foreground launch reply should not mark done while those agents remain running. Individual child sessions never write status; the foreground integration marks done once the manager is clear and the foreground is settled. Also check a session without `pi-subagents`, which should retain foreground-only busy/done behavior. Badge/toast observations are separate from automated wire tests.
