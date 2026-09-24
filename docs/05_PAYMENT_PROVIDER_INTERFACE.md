# Payment provider interface

`src/providers/types.ts` defines the adapter contract:

- `authorize`
- `capture`
- `voidAuthorization`
- `refund`
- `getStatus`
- `listCharges`

The engine calls these methods. It does not contain Paystack, bank, or acquirer HTTP code. `SandboxProvider` is the only adapter. Requesting another provider name is a configuration gap, not a silent fallback.

## Sandbox outcomes

| Signal | Provider result | Red Face status | Ledger |
| --- | --- | --- | --- |
| `approve` | authorize, then capture | `COMPLETED` | one charge |
| `decline` | declined | `DECLINED` | no charge |
| `timeout` | no reference | `UNKNOWN` | no charge |
| `network_error` | charge recorded, response lost | `UNKNOWN` | one charge |

`network_error` is the disagreement case: the provider ledger shows success while Red Face is `UNKNOWN`. `resolve` or a signed `payment.completed` webhook moves that transaction to `COMPLETED` without a second charge.

The sandbox constructor throws if `PAYMENT_ENV` is `production`.
