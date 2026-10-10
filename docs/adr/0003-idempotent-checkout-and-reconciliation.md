# 3. Idempotency keys plus a reconciler for checkout

**Status:** accepted

## Context

Payment requests fail in ambiguous ways. The provider may charge the card and the
response may still never arrive. Retrying blindly can double-charge; giving up can leave
a paid buyer without tickets.

## Decision

- Clients send an `Idempotency-Key` per payment attempt. The server records it before
  doing anything, and stores the final response for replay.
- The order is created before charging, and its id is the provider's idempotency key.
- If the outcome is unknown, the order stays `pending` and the key stays
  `in_progress`. A reconciler asks the provider what happened, settles the order, and
  completes the key, so the client's retry replays the true outcome.

## Consequences

- At most one charge per attempt, even across crashes, double-clicks and network loss.
- A buyer may briefly see "still processing" (`409`) during an outage instead of an
  error that invites a second attempt.
- Every provider integration must support lookups by our order id; the interface makes
  that explicit.
