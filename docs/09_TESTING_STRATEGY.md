# Testing strategy

`npm test` runs `test/payments.test.ts` against the in-memory engine and one HTTP listener.

## Covered now

- Illegal transition from `CREATED` to `COMPLETED`
- Approved tap creates one provider charge, and a retry does not create another
- Network loss leaves `UNKNOWN`, reconciliation reports `STATUS_MISMATCH`, resolve completes the original charge
- Webhook signature failure, signed completion, and duplicate delivery
- Offline card rejection and offline cash completion
- Partial refund, full refund, and an over-refund
- Idempotency key reused with a different amount
- Simulator card presentation returns no card fields
- Sandbox provider refuses production
- Orphan provider charge is `MISSING_REDFACE`
- Remote configuration disables a payment method
- A release walks download, verify, install, and health check before the version changes
- A bad package hash and a failed health check roll back to the previous version
- Pairing issues one device token and rejects the same code afterwards

## Still to add before a partner integration

Provider contract tests for a real adapter, device revocation, replay of signed webhooks with a wrong amount, load on idempotency, and the terminal matrix: reboot, low battery, app crash, locked device, and update rollback. Those need the certified components or an explicit test double beyond this sandbox.
