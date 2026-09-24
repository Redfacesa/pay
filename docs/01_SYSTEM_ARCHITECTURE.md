# System architecture

Red Face Pay Terminal is the software platform around a future certified payment device. This repository does not implement an EMV kernel, PIN pad, or acquirer connection.

```text
Terminal simulator
        │
        ▼
API  ── Payment engine ── Sandbox provider
        │
        ├── Orders and transactions
        ├── Terminal records
        └── Reconciliation
```

The payment engine is the only component allowed to change a transaction status. Provider webhooks are verified, stored, and then applied by that same engine. The simulator never tells the ledger that a card was approved. It sends a sandbox signal. The sandbox provider decides the outcome.

## Boundaries

| Owned here | Left for a certified partner |
| --- | --- |
| Merchant, terminal, order, and transaction records | PCI PTS device |
| State machine, idempotency, receipts | EMV L1/L2 kernel |
| Terminal management actions | PIN entry and key injection |
| Sandbox provider and reconciliation | Acquirer, scheme, and production credentials |

## Runtime

`src/main.ts` binds `0.0.0.0:$PORT` and serves the terminal at `/` and the operations console at `/admin`. The default store is in memory so a developer can run the simulator without Postgres. `db/001_schema.sql` is the PostgreSQL shape the memory store follows. `PAYMENT_ENV=production` refuses the sandbox provider and the default sandbox credentials.

## Build order from here

Database and API are in place for the sandbox. Next adapters implement `PaymentProvider` without changing the engine. Hardware then implements `TerminalHardware` without changing the sale flow.
