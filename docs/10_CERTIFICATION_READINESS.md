# Certification readiness

This repository is not a certified payment terminal and must not be described as one.

PCI PTS covers device security for PIN and account data. EMVCo Level 1 and Level 2 cover the contact and contactless interface and the payment kernel. Those evaluations happen on a specific device and kernel with a recognized laboratory. Nothing in this codebase substitutes for that.

## Ready to hand a partner

- Transaction state machine and the `UNKNOWN` recovery path
- Provider interface with authorize, capture, void, refund, and status
- Hardware interface that does not accept raw card data
- Terminal identity separate from the serial number
- Webhook verification, idempotency, reconciliation states, and audit events
- Schema and API list in this `docs/` folder

## Not started, on purpose

- EMV kernel
- PIN encryption or PIN block handling
- Key injection and key management
- Card-scheme or acquirer certification packs
- Production credential storage
- Offline card authorization
- Physical device manufacturing

Offline card authorization stays disabled. When the network is down the product offers cash only, until an acquirer explicitly supports store-and-forward.

A certification workstream should be planned separately from feature sprints once a hardware and acquiring partner is named.
