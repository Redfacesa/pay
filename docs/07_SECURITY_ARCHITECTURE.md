# Security architecture

## Roles

`SUPER_ADMIN`, `ADMIN`, `OPERATIONS`, `FINANCE`, `SUPPORT`, `MERCHANT`, `TERMINAL`.

The sandbox ships an admin token and a device token. Terminal tokens can sell and read only their own terminal. Refunds require admin, finance, or super admin. Lock and configuration require admin, operations, or super admin.

## Secrets and transport

API calls use `Authorization: Bearer`. Webhooks use `X-Redface-Signature`, an HMAC-SHA256 hex digest of the raw body, compared with `timingSafeEqual`. The process refuses to boot when `PAYMENT_ENV=production` and a sandbox token or the default webhook secret is still set.

## Data we do not store

Card PAN, CVV, PIN, track data, and sensitive authentication data are out of the schema, the provider interface, and the simulator. Receipts print the Red Face transaction id, amount, method, and provider reference.

## Still required before production

MFA for administrators, token rotation, device certificates, encrypted secret storage, rate limiting, and a review of the real deployment against the compliance architecture. Those are not claimed by this sandbox.
