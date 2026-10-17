# Optional Warp completion summaries

## Approved intent

Replace the static Warp completion response with an optional 5–8-word summary of Pi's latest turn, using a configured lightweight model. Latency hiding is explicitly out of scope. The existing foreground-settlement, managed-work polling, and 500 ms completion-grace decisions remain unchanged; generation starts only where the extension would currently emit `stop`.

Requires Pi **1.2.0 or newer**, as subsequently approved by the user.

## Configuration

Read `<agent-dir>/warp-simple-status.json`, respecting Pi's agent-directory override. Example:

```json
{
  "summary": {
    "provider": "anthropic",
    "model": "claude-haiku-4-5",
    "timeoutMs": 10000
  }
}
```

Resolve provider/model through Pi's existing registry and credentials. Do not define a second credential store, choose the active conversation model implicitly, or modify the user's global files. No configuration means current static behavior.

Implementation defaults: timeout defaults to 10000 ms when omitted; otherwise it must be a positive finite integer within Node's timer range. Missing, unreadable, or invalid configuration disables generation. Read configuration once at extension registration; `/reload` picks up changes.

## Generation and lifecycle

At the existing definitive completion point, snapshot the latest user request and final assistant text from the current session branch. Exclude thinking, tool calls, raw tool output, and older conversation. Bound input to 12000 characters total. A direct model call has no tools and does not insert messages into the conversation or invoke Pi's agent loop.

Ask for exactly 5–8 words describing the outcome, preserving questions, uncertainty, failures, or partial completion. Treat source text as untrusted data, not instructions. Normalize whitespace and accept only 5–8 whitespace-delimited words with no control characters, capped at 160 characters. Do not retry malformed output. These bounds and validation choices are implementation defaults rather than additional user requirements.

On timeout, model/auth failure, missing usable assistant text, or invalid output, send `Pi finished responding.`. The timeout bounds the entire async attempt, including credential resolution; do not depend on a provider honoring abort. Abort the request when the timeout expires.

Keep one pending summary per completion. Continue the existing busy heartbeat until its response/fallback is ready. New foreground work, session replacement, and shutdown abort/invalidate the pending attempt. A stale promise must not emit completion or change the new turn's timers. Repeated settlement must not generate duplicate calls. Recheck managed-work status before emission using the existing completion gate, so work that resumed during generation cannot be marked done. Do not introduce another grace period merely because generation completes; newly observed managed work still earns the existing grace when it drains. Retain the single generated result or fallback while waiting, rather than making another model call.

## Privacy and compatibility

Without configuration, existing immediate static behavior and wire payloads are unchanged. With configuration, selected request/reply text is sent to the selected model provider and a derived short summary is sent to Warp; explain this opt-in privacy change in README. Never trace prompts, replies, credentials, model output, or provider errors containing such content.

Preserve session ownership, non-TUI exclusions, managed-work adapter semantics, and best-effort terminal error containment. No changes to pi-subagents or Pi user settings. No speculative summaries, new commands, project configuration overrides, UI, or new status protocol.

## Verification

Tests inspect actual encoded OSC writes as well as mocked model requests. Cover exact existing static output, configuration and model/auth failures, timeout with an abort-ignoring provider, text-only branch extraction, strict output validation, one call after the existing grace deadline, stale-result cancellation, duplicate settlement, resumed managed work, and clean timers. Run the complete existing suite and TypeScript check. Live model access and Warp toast appearance require separate real-environment verification; automated tests must not be described as proving them.
