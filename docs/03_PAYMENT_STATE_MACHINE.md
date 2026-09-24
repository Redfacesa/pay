# Payment state machine

Implementation: `src/domain/state-machine.ts`. Every status change goes through `assertTransition`. A sale cannot jump from `CREATED` to `COMPLETED`.

```text
CREATED
  → INITIATED
      → PROCESSING
          → AUTHORIZED → COMPLETED → REFUNDED
          → FAILED                    → PARTIALLY_REFUNDED → REFUNDED
          → DECLINED
          → CANCELLED
          → UNKNOWN
      → CANCELLED
      → UNKNOWN
```

`UNKNOWN` is the state where the response was lost. It can later become `COMPLETED`, `FAILED`, `DECLINED`, `AUTHORIZED`, `CANCELLED`, or return to `PROCESSING`. It exists so the terminal does not report a failure while the provider has a successful charge.

`PARTIALLY_REFUNDED` can accept another partial refund or a final refund that reaches the captured amount.

Cash uses the same path: `CREATED → INITIATED → PROCESSING → AUTHORIZED → COMPLETED`. Cash does not call a card provider.

Card, tap, and QR stop at `INITIATED` until the provider returns. A sandbox network error stores the provider reference, moves to `UNKNOWN`, and does not open a second charge when the same idempotency key is retried.
