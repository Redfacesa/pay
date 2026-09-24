# Red Face payment terminal

Software platform for a future payment terminal: sale, payment session, sandbox provider, terminal simulator, and operations console. It does not read cards, store PANs, or talk to a production acquirer.

## Run

```bash
npm install
npm start
```

- Terminal simulator: http://localhost:8787/
- Operations console: http://localhost:8787/admin

`npm test` covers the state machine, idempotency, the lost-response case, refunds, webhooks, and the HTTP sale.

Copy `.env.example` if you want to override the host, port, or sandbox credentials. `PAYMENT_ENV=production` will not boot with those sandbox credentials, and the sandbox provider refuses to construct in production.

Postgres is not required to run the simulator. `db/001_schema.sql` is the schema the in-memory store follows.

## What a sale does

1. Enter an amount on the terminal and choose tap.
2. The sandbox controls approve, decline, time out, or drop the network.
3. Approve writes one transaction, for example `RF-TX-000001`, for `R 250.00`.
4. The admin console shows that transaction, the terminal, and reconciliation.
5. Network error leaves the payment `UNKNOWN` and records a single provider charge. Check status completes that same charge. It does not take the money twice.

Cash still works when the simulated network is down. Card, tap, and QR do not.

The terminal has Sale, History, and Settings. Operations shows the merchant, a terminal detail page (health, software, configuration, audit), register/pair, remote payment methods, software releases with rollback, reconciliation, and settlement. The simulator installs versions one heartbeat at a time through `UPDATE_DETECTED` → `COMPLETED`. See `docs/11_PLATFORM_CONTRACT.md`.
