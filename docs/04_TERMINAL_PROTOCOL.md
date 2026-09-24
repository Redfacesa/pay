# Terminal protocol

The simulator at `/` is the stand-in for the future terminal application.

## Identity

Each terminal has a business id such as `RF-TERM-000001` and a separate bearer token. The serial number is not the credential. The seeded sandbox token is returned by `GET /api/v1/sandbox/bootstrap` and that route is absent when `PAYMENT_ENV=production`.

## Sale

1. `POST /api/v1/sales` with `Idempotency-Key`, amount in cents, currency, and method.
2. Cash completes on the terminal if the terminal is not locked.
3. Card, tap, and QR return a payment session in `INITIATED`.
4. `POST /api/v1/payment-sessions/:id/authorize` sends a simulator signal: `approve`, `decline`, `timeout`, or `network_error`.
5. The same authorize key returns the original transaction and does not call the provider again.

## Network

`POST /api/v1/terminals/:id/heartbeat` with `{ "online": false }` marks the terminal `OFFLINE` unless it is locked or disabled. Card, tap, and QR are rejected with `NETWORK_UNAVAILABLE`. Cash still completes.

## Commands

Admin and operations can `lock`, `unlock`, `disable`, `enable`, `restart`, and `update`. Restart and update are queued. The terminal acknowledges them on a later heartbeat with `ack_command: true`. This build does not download or install a package.

## Configuration

`PUT /api/v1/terminals/:id/config` updates booleans for receipt, cash, card, tap, and QR, plus `idle_timeout` from 15 to 3600 seconds. Currency stays `ZAR`. The terminal reads that configuration on its heartbeat and hides disabled methods.

## Pairing

`POST /api/v1/terminals` registers an offline terminal and returns a pairing code. `POST /api/v1/terminals/pair` exchanges that code for a device token. The code works once. In this sandbox the pair route is open. It is not available when `PAYMENT_ENV=production`.

## Software updates

`POST /api/v1/terminals/:id/releases` queues a version at `UPDATE_DETECTED`. Each heartbeat, while auto-update is on and the terminal is online, advances one step:

`UPDATE_DETECTED` → `DOWNLOADING` → `DOWNLOADED` → `VERIFYING` → `VERIFIED` → `INSTALLING` → `HEALTH_CHECK` → `COMPLETED`.

A hash mismatch during verify, or a failed health check, ends in `ROLLED_BACK` and leaves the previous version in place. This does not download a binary package.
