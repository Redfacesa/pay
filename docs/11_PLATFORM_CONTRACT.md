# Platform contract

This is the formal boundary around what already works. Do not rebuild these pieces. Extend them.

## Proven capabilities

| Capability | Contract |
| --- | --- |
| Terminal registration | `POST /api/v1/terminals` returns id and one-time `pairing_code` |
| Pairing | `POST /api/v1/terminals/pair` exchanges the code for a device token once |
| Heartbeat | `POST /api/v1/terminals/:id/heartbeat` updates presence and advances updates |
| Terminal authentication | Bearer device token scoped to one terminal |
| Payment-method configuration | `PUT /api/v1/terminals/:id/config` |
| Release publishing | `POST /api/v1/terminals/:id/releases` |
| Update lifecycle | See state machine below |
| Hash verification | Package hash must match the published release |
| Installation | Version changes only after `VERIFIED` and `INSTALLING` |
| Health check | Failed health check rolls back to `previous_version` |
| Rollback | Terminal stays on the previous software version |
| Version reporting | Heartbeat and detail views expose `software_version` |
| Cash sale | Sale → order → completed transaction → history |
| Card / tap / QR simulator | Payment session + sandbox signals |
| Refunds | Partial and full against a completed capture |
| Reconciliation | Provider ledger versus Red Face ledger |
| Revocation | `POST .../commands` with `action: revoke` disables the terminal and drops device tokens |

## Software update state machine

```text
UPDATE_DETECTED
   ↓
DOWNLOADING
   ↓
DOWNLOADED
   ↓
VERIFYING
   ├── FAIL → ROLLED_BACK
   ↓
VERIFIED
   ↓
INSTALLING
   ↓
HEALTH_CHECK
   ├── FAIL → ROLLED_BACK
   ↓
COMPLETED
```

A release is never installed merely because it exists. Auto-update must be on, the terminal must be online, and each heartbeat advances one step.

Integrity today is a hash check. Authenticity (signed releases from an authorized Red Face process) is still ahead.

## Payment transaction state machine

```text
CREATED → INITIATED → PROCESSING → AUTHORIZED → COMPLETED
                              ↘ FAILED / DECLINED / CANCELLED / UNKNOWN
COMPLETED → PARTIALLY_REFUNDED → REFUNDED
```

`UNKNOWN` is reserved for a lost provider response. Resolve or a signed webhook must complete the original charge. A retry with the same idempotency key must not create a second charge.

## Merchant and terminal detail

- `GET /api/v1/merchants` and `GET /api/v1/merchants/:id` return business, terminals, and today's sales.
- `GET /api/v1/terminals/:id/detail` returns configuration, software, health, audit, and logs.

## Simulator signals

`approve`, `decline`, `timeout`, `network_error`, `provider_failure`, `cancel`.

None of these accept or store a PAN, PIN, or CVV.
