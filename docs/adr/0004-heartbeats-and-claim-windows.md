# 4. Heartbeats and claim windows in the waiting room

**Status:** accepted (added after load testing)

## Context

The first 2,000-buyer load test sold out correctly but left 1,300 buyers waiting for
minutes. People who gave up while queued were still admitted later, and each held a
shopping slot for the full 10-minute access window. Capacity was being spent on empty
browser tabs.

## Decision

- Each queue poll refreshes a 20-second heartbeat. The admitter skips sessions whose
  heartbeat has lapsed and counts them as abandoned.
- Admission grants a 30-second claim window. Only when the buyer polls and receives
  their access pass does it become the full access window.
- When every seat is sold, the queue answers `sold_out` immediately.

## Consequences

- Shopping slots go to people who are actually present; the same test now sells out
  in ~20 seconds and releases everyone else with an honest answer.
- Clients must keep polling to hold their place. This is also the behaviour buyers
  expect ("keep this tab open").
- The crowd simulator's bots, which can't poll, join with a longer heartbeat.
