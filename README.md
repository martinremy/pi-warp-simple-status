# pi-warp-simple-status

Busy and done status for [Pi](https://pi.dev) in [Warp](https://www.warp.dev), with optional subagent-aware completion. Warp stays busy while the foreground assistant is working and, when `@tintinweb/pi-subagents` is available, while its manager still has running or queued work. Done is sent only after the foreground response has settled and that managed work has cleared.

A deliberately smaller alternative to `rpiv-warp`: no child-session notifications, question events, idle timer, or custom tab-title spinner.

## Install

Requires **Pi 1.2.0 or newer** and a Warp build that advertises structured CLI-agent protocol support. Clone the repo, then point `pi install` at the checkout:

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

Start Pi inside Warp and use it normally. No configuration is required. By default, completion text is “Pi finished responding.” Enable optional model-generated summaries below.

| Pi lifecycle | Sent to Warp |
| --- | --- |
| Interactive session starts or switches, before any work | Nothing — track the session internally |
| First foreground agent run in that session starts | `session_start`, then `prompt_submit` — announce and mark busy |
| Subsequent foreground agent runs start | `prompt_submit` — busy |
| Foreground agent settles, and managed work is clear | Optional summary generation, then `stop` — done |

A busy heartbeat repeats every 15 seconds while waiting for either the foreground response or managed work to finish. After foreground settlement, managed status is checked every 250 ms. Once observed managed work drains, completion gets a cancellable **500 ms grace period** so its notification can start a foreground follow-up without an extra done/busy cycle. The heartbeat stays active during grace; completion, session replacement, and shutdown clear all timers. There is no delayed `idle_prompt` event.

## Optional completion summaries

Create **`~/.pi/agent/warp-simple-status.json`**, or place it in your configured Pi agent directory if you use `PI_CODING_AGENT_DIR`:

```json
{
  "summary": {
    "provider": "anthropic",
    "model": "claude-haiku-4-5",
    "timeoutMs": 10000
  }
}
```

Choose a lightweight model registered in Pi and authenticated through Pi's existing provider configuration (`/login`, environment credentials, or your configured provider). This file selects a model; it does not define endpoints or store credentials. Custom model definitions still belong in Pi's `models.json`. The example requires access to that provider/model; nothing is selected or configured automatically.

Restart Pi or use `/reload` after editing the file. Configuration is read once when the extension loads. Remove the file to restore static messages. A missing, unreadable, or malformed file disables summaries. `provider` and `model` must be nonempty strings. `timeoutMs` defaults to **10000** when omitted and must otherwise be an integer between 1 and 2147483647.

Generation starts **only after the existing completion decision**, including foreground settlement, managed-work clearance, and any 500 ms grace period. There is no speculative generation or change to those timing rules. Warp stays busy, with its existing heartbeat, until a summary is ready. The extension requests a **5–8-word** outcome using only the latest user request and final assistant text from the active branch (at most 6000 characters each); thinking, images, tool calls, tool results, and older turns are excluded. The direct model call has no tools and does not add messages to the conversation.

**Timeouts and errors fall back to “Pi finished responding.”** This includes an unavailable model, failed authentication, missing usable final text, incomplete generation, and invalid output. The deadline covers the entire async request, including authentication. There is one attempt, with no retries. Summaries are whitespace-normalized and must contain 5–8 words and at most 160 characters; unsafe control characters are rejected. If a new turn starts, the session changes, or Pi shuts down, the pending summary is cancelled and cannot send a stale completion. Managed work is checked again before sending `stop`.

**Privacy:** enabling summaries sends the selected request/reply text to the configured model provider and sends the derived summary to Warp, where it may appear in OS notifications. Without this configuration, no conversation content is sent to Warp or a summary model. Diagnostic traces never include summary inputs, outputs, or credentials.

## Behavior notes

- **No Warp indicator is introduced before the first prompt.** Warp's `session_start` announcement is deferred until actual foreground work begins, because announcing an idle session produces a busy indicator. Startup and idle session switches emit no status, and do not send a fake completion to clear the badge. Switching sessions does not explicitly clear an indicator left by earlier work.
- **Done means the foreground response has settled and no running or queued work remains in the optional subagent manager.** Launching background agents no longer produces completion just because the foreground reply ends.
- The `pi-subagents` check is **manager-wide**: nested agents, workflows, and work retained across a session switch can hold completion. It is not filtered to the current turn or session. This extension does not independently announce jobs started while it is idle; it checks managed work when a foreground run settles.
- `@tintinweb/pi-subagents` is **optional** and is not imported or installed by this extension. If its registry or callable status method is absent, completion is foreground-only. The documented registry API was checked against version 0.20.0 and is looked up dynamically, avoiding extension load-order dependence.
- Status-check exceptions are contained. An installed manager that throws or reports an unexpected result is treated as busy, and checks continue until it reports `false`. If the registry is removed, the extension returns to foreground-only behavior.
- Only interactive terminal sessions (`ctx.mode === "tui"`) are eligible. Events must also match the session ID captured by that extension instance. RPC, JSON, print, and headless child sessions are ignored.
- Uses `agent_settled`, not `agent_end`: the latter can precede retries, compaction, and automatic continuation. If another foreground response starts while waiting for background work or during completion grace, completion also waits for that response to settle. Each continuous busy period sends completion once.
- Grace applies only to a busy period that observed blocking managed work; ordinary foreground-only completion remains immediate when summaries are disabled. New foreground or managed work cancels pending completion, and both conditions are checked again when grace expires. Repeated idle checks do not postpone the timer.
- The grace window starts when the whole manager clears, not whenever an individual agent finishes, so staggered completions are supported. It is a bounded workaround for notification delivery latency, **not a guarantee against arbitrarily delayed follow-ups**. No `pi-subagents` changes or blanket suppression of legitimate new turns are involved.
- State and heartbeat timers are owned by each extension instance. A child instance cannot cancel the foreground instance's heartbeat.
- Does not change Pi's own spinner or terminal title, or register model tools. Model calls occur only when completion summaries are explicitly configured.
- Sends project directory and session identity. Without summary configuration, it sends **no conversation content** and completion text is simply “Pi finished responding.” Configured summaries send derived turn content as described above.
- Outside Warp or without a positive structured-protocol version, it does nothing. Terminal writes are best-effort; an unavailable terminal cannot interrupt Pi.
- macOS/Linux write OSC 777 to `/dev/tty`. Windows uses TTY stdout as a best-effort fallback.
- **Warp controls badge appearance and OS toasts**, including focus behavior, notification permissions, and Do Not Disturb. Warp may prepend its own **“Latest output:”** label to the completion response; the extension sends only the summary text and does not add that label. The current `response` field does not let this extension suppress Warp's label. Sending `stop` does not guarantee a visible toast. The wire mapping is covered by automated tests; live busy/done rendering and toast behavior still require confirmation in Warp.

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
  `completion_grace` after managed-work grace, `agent_settled` for immediate
  foreground-only completion, or `manager_poll` when a configured summary becomes
  ready after the completion gate. The deferred `session_start` announcement has
  reason `agent_start`; it is emitted immediately before the first busy event
  in that session. Busy events distinguish `agent_start` from `heartbeat`.
- `kind: "completion"` records grace being `scheduled`, `cancelled`, or
  `elapsed`. `completionPending` and `hadManagedWork` appear in state snapshots.
- `kind: "summary"` records `request_started` and a metadata-only outcome:
  `succeeded`, `timed_out`, `cancelled`, `model_unavailable`, `no_turn_text`,
  `request_failed`, `incomplete_length`, `incomplete_response`, `invalid_controls`,
  or `invalid_output`. These events never include conversation text, generated
  text, or raw provider error messages.

Two `emit/stop` records mean this extension attempted two completion events.
One such record does not rule out another notification source, such as Pi's
built-in terminal status reporting. An emission record does not prove transport
success or a displayed toast.

File-write/inspection failures are swallowed. New files use mode `0600` on
platforms that honor it; existing permissions are not tightened. Synchronous
logging can affect timing, so use a normal local file and unset the variable
when the capture is complete. The old `RPIV_WARP_TRACE` variable is not used.

## Development

The Pi entry point is [`src/index.ts`](src/index.ts); the stateless Warp transport lives in [`src/warp.ts`](src/warp.ts), the optional manager adapter in [`src/subagents.ts`](src/subagents.ts), and global summary configuration/model requests in [`src/summary.ts`](src/summary.ts). Pi loads TypeScript directly via jiti—no runtime build step or third-party runtime dependency.

```sh
npm ci
npm test
npm run check
```

Tests inspect encoded terminal writes and exercise silent idle startup and session replacement, first-run announcement ordering and deduplication, foreground/headless separation, heartbeat ownership, session changes, settlement, optional/missing manager behavior, managed-job completion/cancellation, completion grace and delayed follow-up deduplication, safe status-call failures, and transport failure cleanup. After editing, restart Pi or use `/reload` to pick up changes.

For a live check, use only this integration. Launch a fresh empty session without sending a prompt and confirm no indicator appears; run `/new` before the first prompt and confirm it remains silent. Send a first prompt and confirm busy/done behavior starts normally. Then observe a normal foreground turn, a turn lasting more than 15 seconds, and two background agents waiting for 45 seconds. With `pi-subagents` available, the foreground launch reply should not mark done while those agents remain running. Individual child sessions never write status; the foreground integration marks done once the manager is clear and the foreground is settled. Also check a session without `pi-subagents`, which should retain foreground-only busy/done behavior. With summary configuration enabled, also confirm that a completed turn produces a short outcome notification and an unavailable model falls back to the static message. Badge/toast observations and live provider access are separate from automated wire tests.
