#!/usr/bin/env bash
# Minimal fake `pi --mode json --print`: a session header + a `message_end` event (the real Pi
# stdout shape), then exit. Honors PI_STUB_SLEEP to simulate a slow/hung agent for timeout tests.
sleep "${PI_STUB_SLEEP:-0}"
printf '%s\n' '{"type":"session","version":3,"id":"sess-stub","timestamp":"2026-06-30T00:00:00Z","cwd":"/tmp"}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","stopReason":"stop","usage":{"input":10,"output":5},"content":[{"type":"text","text":"stub-ok"}]}}'
exit 0
