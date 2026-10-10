# pi-warp-simple-status

Foreground-only busy and done status for [Pi](https://pi.dev) in [Warp](https://www.warp.dev). Warp sees the session as busy while the foreground assistant is working, then receives a completion event when that response has settled—including any automatic retries, compaction, or continuation.

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
| Interactive session starts or switches | `session_start` — announce the session |
| Foreground agent starts | `prompt_submit` — busy |
| Foreground agent settles | `stop` — done |

A busy heartbeat repeats every 15 seconds during an active foreground run to keep Warp from treating a long-running task as idle. It stops on settlement or session shutdown. There is no delayed `idle_prompt` event.

## Behavior notes

- **Done means the foreground assistant has finished responding.** Background subagents may still be running. Launching a background agent and finishing the foreground reply counts as done; the background agent's own completion does not send a status event.
- Only interactive terminal sessions (`ctx.mode === "tui"`) are eligible. Events must also match the session ID captured by that extension instance. RPC, JSON, print, and headless child sessions are ignored.
- Uses `agent_settled`, not `agent_end`: the latter can precede retries, compaction, and automatic continuation. Each active run sends completion once.
- State and heartbeat timers are owned by each extension instance. A child instance cannot cancel the foreground instance's heartbeat.
- Does not change Pi's own spinner or terminal title, register model tools, or call a model.
- Sends project directory and session identity, but **no prompt, reply, question, or tool-input content**. Completion text is simply “Pi finished responding.”
- Outside Warp or without a positive structured-protocol version, it does nothing. Terminal writes are best-effort; an unavailable terminal cannot interrupt Pi.
- macOS/Linux write OSC 777 to `/dev/tty`. Windows uses TTY stdout as a best-effort fallback.
- **Warp controls badge appearance and OS toasts**, including focus behavior, notification permissions, and Do Not Disturb. Sending `stop` does not guarantee a visible toast. The wire mapping is covered by automated tests; live busy/done rendering and toast behavior still require confirmation in Warp.

## Development

The Pi entry point is [`src/index.ts`](src/index.ts); the stateless Warp transport lives in [`src/warp.ts`](src/warp.ts). Pi loads TypeScript directly via jiti—no runtime build step or third-party runtime dependency.

```sh
npm ci
npm test
npm run check
```

Tests inspect encoded terminal writes and exercise foreground/headless separation, heartbeat ownership, session changes, settlement, and transport failure cleanup. After editing, restart Pi or use `/reload` to pick up changes.

For a live check, use only this integration and observe a normal foreground turn, a turn lasting more than 15 seconds, and a background-subagent launch. The foreground reply should mark done even if background work continues; individual child events should not change that status. Badge/toast observations are separate from automated wire tests.
