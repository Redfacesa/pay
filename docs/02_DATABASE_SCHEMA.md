# Database schema

The PostgreSQL definition is `db/001_schema.sql`. Amounts are integer cents. Currency in this build is `ZAR`.

There is no column for a PAN, expiry, CVV, PIN, track, or other sensitive authentication data. Do not add one.

## Tables

| Table | Purpose |
| --- | --- |
| `users` | People and roles |
| `businesses` | Legal business behind a merchant |
| `merchant_accounts` | Processor account and settlement destination |
| `terminals` | Device identity, status, location, remote config, queued command |
| `devices` | Hardware identity separate from the terminal business id |
| `orders` | One sale. Payment status is unpaid, paid, partial, or refunded |
| `payment_sessions` | The in-progress attempt the terminal is waiting on |
| `transactions` | The payment record and its state-machine status |
| `refunds` | Each refund against a capture |
| `payment_events` | Append-only timeline |
| `webhook_events` | Provider events, unique per provider and external id |
| `idempotency_keys` | One key per scope, bound to the request hash |
| `audit_logs` | Who did what, to what, when |

`transactions.session_id` is filled after the session row exists, so the foreign key is added after both tables.

Indexes cover merchant and terminal history, provider reference lookup, event timelines, and audit lookup.
