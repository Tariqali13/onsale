# 2. Holds replace the whole cart, all or nothing

**Status:** accepted

## Context

Ticket buyers usually want seats together. Holding seats one at a time lets two buyers
each grab half of a block, so neither can complete their group, and leaves behind
partial holds that block other people until they expire.

## Decision

`PUT /cart` takes the complete set of seats the buyer wants and applies it in one Lua
script: every seat is free (or already theirs) and becomes held, or nothing changes and
the response names the contested seat. Seats from the previous cart that are not in the
new set are released in the same step.

## Consequences

- No partial holds, no orphaned seats from an earlier selection.
- The client decides seat order and adjacency; "best available" is a client-side search
  over the latest availability, followed by an ordinary atomic hold.
- A `409` tells the client exactly which seat to drop, so recovery is one click.
