# API specification

Base path `/api/v1`. Amounts are integer cents. Errors are `{ "error": { "code", "message" } }`.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | no | Process up |
| GET | `/sandbox/bootstrap` | no, sandbox only | Demo tokens |
| POST | `/sales` | terminal | Create order, transaction, and session |
| POST | `/payment-sessions/:id/authorize` | terminal | Submit simulator signal |
| POST | `/payment-sessions/:id/cancel` | terminal | Cancel an open session |
| POST | `/transactions/:id/resolve` | reader | Ask the provider for the real status |
| GET | `/transactions` | reader | List, optional `terminal_id` and `status` |
| GET | `/transactions/:id` | reader | One transaction, events, receipt |
| POST | `/refunds` | finance | `{ transaction_id, amount, reason }` |
| POST | `/terminals` | operations | Register a terminal and receive a pairing code |
| POST | `/terminals/pair` | sandbox, no auth | Exchange a pairing code for a device token |
| POST | `/terminals/:id/releases` | operations | Queue a software release |
| GET | `/terminals/:id/logs` | reader | Terminal log |
| POST | `/terminals/:id/heartbeat` | terminal | `{ online, ack_command }` |
| POST | `/terminals/:id/commands` | operations | lock, unlock, disable, enable, restart, update |
| GET, PUT | `/terminals/:id/config` | read / operations | Remote configuration |
| GET | `/reports/overview` | reader | Today's volume and terminal counts |
| GET | `/settlements` | reader | Gross, fees, refunds, net |
| GET | `/reconciliation` | reader | Provider ledger versus Red Face |
| POST | `/webhooks/sandbox` | HMAC | `payment.completed`, `payment.failed`, `payment.declined`, `payment.authorized` |

`POST /sales`, authorize, and refund require `Idempotency-Key` (8 to 120 characters). The same key and same body returns the original transaction. The same key and a different body returns `409 IDEMPOTENCY_CONFLICT`.

Webhook body:

```json
{
  "id": "evt_1",
  "type": "payment.completed",
  "data": { "reference": "SBX-000001", "amount": 25000, "currency": "ZAR" }
}
```

A repeated webhook id is acknowledged and not applied twice. An amount that does not match the transaction returns `409` and does not change status.
