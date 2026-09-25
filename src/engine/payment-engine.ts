import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "../domain/errors.ts";
import { requestHash } from "../domain/hash.ts";
import { assertAmount, assertCurrency, feeCents, formatZar } from "../domain/money.ts";
import { reconcile, type ReconReport } from "../domain/reconcile.ts";
import { assertTransition, type TransactionStatus } from "../domain/state-machine.ts";
import { assertUpdateTransition, isActiveUpdate } from "../domain/update-machine.ts";
import type {
  Actor,
  AuditLog,
  PaymentEvent,
  PaymentMethod,
  PaymentSession,
  Refund,
  SimulatorSignal,
  Terminal,
  TerminalConfig,
  Transaction,
  UpdateJob,
} from "../domain/types.ts";
import { PAYMENT_METHODS } from "../domain/types.ts";
import type { PaymentProvider, ProviderCharge } from "../providers/types.ts";
import { MemoryStore } from "../store/memory.ts";

const SESSION_TTL_MS = 10 * 60 * 1000;
const CARD_METHODS = new Set<PaymentMethod>(["card", "tap", "qr"]);

export type EngineConfig = {
  webhookSecret: string;
  now?: () => Date;
  faultInjection?: boolean;
};

export type TransactionView = {
  id: string;
  merchant_id: string;
  merchant_name: string;
  terminal_id: string;
  terminal_location: string;
  order_id: string;
  session_id: string | null;
  amount: number;
  amount_display: string;
  currency: "ZAR";
  payment_method: PaymentMethod;
  processor: string;
  processor_reference: string | null;
  status: TransactionStatus;
  authorization_code: string | null;
  refunded_amount: number;
  refunded_display: string;
  created_at: string;
  completed_at: string | null;
  events: Array<{
    id: string;
    event_type: string;
    source: string;
    timestamp: string;
    payload: Record<string, unknown>;
  }>;
  receipt: string | null;
};

function assertSignal(value: unknown): SimulatorSignal {
  if (
    value === "approve" ||
    value === "decline" ||
    value === "timeout" ||
    value === "network_error" ||
    value === "provider_failure" ||
    value === "cancel"
  ) {
    return value;
  }
  throw new AppError(
    "VALIDATION",
    "Simulator signal must be approve, decline, timeout, network_error, provider_failure, or cancel.",
    400,
  );
}

function assertMethod(value: unknown): PaymentMethod {
  if (typeof value === "string" && (PAYMENT_METHODS as readonly string[]).includes(value)) {
    return value as PaymentMethod;
  }
  throw new AppError("VALIDATION", "Payment method must be cash, card, tap, or qr.", 400);
}

export class PaymentEngine {
  readonly store: MemoryStore;
  private readonly provider: PaymentProvider;
  private readonly config: EngineConfig;
  private readonly now: () => Date;

  constructor(store: MemoryStore, provider: PaymentProvider, config: EngineConfig) {
    this.store = store;
    this.provider = provider;
    this.config = config;
    this.now = config.now ?? (() => new Date());
  }

  createSale(input: {
    actor: Actor;
    terminalId: string;
    amount: unknown;
    currency: unknown;
    paymentMethod: unknown;
    idempotencyKey: string;
  }): TransactionView {
    const amount = assertAmount(input.amount);
    const currency = assertCurrency(input.currency) as "ZAR";
    const paymentMethod = assertMethod(input.paymentMethod);
    const terminal = this.requireTerminal(input.terminalId);
    this.assertTerminalCanSell(input.actor, terminal, paymentMethod);
    this.assertMethodEnabled(terminal, paymentMethod);

    const hash = requestHash({
      terminalId: terminal.id,
      amount,
      currency,
      paymentMethod,
    });
    const existing = this.beginIdempotency("sale", input.idempotencyKey, hash, null);
    if (existing) return this.mustView(existing);

    const now = this.timestamp();
    const orderId = this.store.next("ORD-");
    const transactionId = this.store.next("RF-TX-");
    const sessionId = paymentMethod === "cash" ? null : this.store.next("PS-");
    this.finishIdempotencyLink("sale", input.idempotencyKey, transactionId);

    this.store.orders.set(orderId, {
      id: orderId,
      merchantId: terminal.merchantId,
      customerId: null,
      subtotal: amount,
      tax: 0,
      discount: 0,
      total: amount,
      currency,
      paymentStatus: "unpaid",
      fulfillmentStatus: "not_applicable",
      createdAt: now,
    });

    const transaction: Transaction = {
      id: transactionId,
      merchantId: terminal.merchantId,
      terminalId: terminal.id,
      orderId,
      sessionId,
      amount,
      currency,
      paymentMethod,
      processor: paymentMethod === "cash" ? "cash" : this.provider.name,
      processorReference: null,
      status: "CREATED",
      authorizationCode: null,
      refundedAmount: 0,
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
      completedAt: null,
    };
    this.store.transactions.set(transactionId, transaction);
    this.recordEvent(transaction, "payment.created", "terminal", { amount, currency, paymentMethod });
    this.transition(transaction, "INITIATED", "payment.initiated", "terminal");

    if (sessionId) {
      const session: PaymentSession = {
        id: sessionId,
        merchantId: terminal.merchantId,
        terminalId: terminal.id,
        orderId,
        transactionId,
        amount,
        currency,
        paymentMethod,
        provider: this.provider.name,
        status: "open",
        expiresAt: new Date(this.now().getTime() + SESSION_TTL_MS).toISOString(),
        createdAt: now,
      };
      this.store.sessions.set(sessionId, session);
    } else {
      this.completeCash(transaction);
    }

    this.audit(input.actor, "sale.created", "transaction", transaction.id, {
      amount,
      paymentMethod,
      orderId,
    });
    this.log(terminal.id, "info", `Sale ${transaction.id} created for ${formatZar(amount)} via ${paymentMethod}.`);
    this.touchTerminal(terminal);
    this.finishIdempotency("sale", input.idempotencyKey);
    return this.view(transaction);
  }

  async authorize(input: {
    actor: Actor;
    sessionId: string;
    idempotencyKey: string;
    signal: unknown;
  }): Promise<TransactionView> {
    const signal = assertSignal(input.signal);
    const session = this.store.sessions.get(input.sessionId);
    if (!session) throw new AppError("NOT_FOUND", "Payment session not found.", 404);
    const terminal = this.requireTerminal(session.terminalId);
    this.assertActorTerminal(input.actor, terminal);
    if (terminal.status === "LOCKED" || terminal.status === "DISABLED") {
      throw new AppError("TERMINAL_LOCKED", "This terminal cannot take payments.", 423);
    }
    if (terminal.status === "OFFLINE") {
      throw new AppError(
        "NETWORK_UNAVAILABLE",
        "Card payments unavailable. Cash sale available.",
        409,
      );
    }

    const transaction = this.mustTransaction(session.transactionId);
    const hash = requestHash({ sessionId: session.id, signal });
    const replay = this.beginIdempotency("authorize", input.idempotencyKey, hash, transaction.id);
    if (replay) return this.mustView(replay);

    if (session.status !== "open" || transaction.status !== "INITIATED") {
      this.releaseIdempotency("authorize", input.idempotencyKey);
      throw new AppError("CONFLICT", "This payment session is no longer open.", 409);
    }
    if (this.now().getTime() > Date.parse(session.expiresAt)) {
      session.status = "expired";
      this.transition(transaction, "CANCELLED", "payment.cancelled", "system", { reason: "session_expired" });
      this.releaseIdempotency("authorize", input.idempotencyKey);
      throw new AppError("SESSION_EXPIRED", "Payment session expired.", 409);
    }

    session.status = "processing";
    this.transition(transaction, "PROCESSING", "payment.processing", "terminal", { signal });

    let result;
    try {
      result = await this.provider.authorize({
        transactionId: transaction.id,
        amount: transaction.amount,
        currency: transaction.currency,
        idempotencyKey: input.idempotencyKey,
        signal,
      });
    } catch (error) {
      transaction.processorReference = transaction.processorReference;
      this.transition(transaction, "UNKNOWN", "payment.unknown", "provider", {
        reason: error instanceof Error ? error.message : "provider_error",
      });
      session.status = "open";
      this.finishIdempotency("authorize", input.idempotencyKey);
      return this.view(transaction);
    }

    if (result.outcome === "authorized") {
      transaction.processorReference = result.reference;
      transaction.authorizationCode = result.authorizationCode;
      this.transition(transaction, "AUTHORIZED", "payment.authorized", "provider", {
        reference: result.reference,
      });
      const captured = await this.provider.capture({
        transactionId: transaction.id,
        reference: result.reference,
        amount: transaction.amount,
        currency: transaction.currency,
      });
      if (captured.outcome === "captured") {
        this.markCompleted(transaction, session);
      } else {
        this.transition(transaction, "UNKNOWN", "payment.unknown", "provider", {
          reference: captured.reference,
          reason: "capture_response_lost",
        });
      }
    } else if (result.outcome === "declined") {
      transaction.processorReference = result.reference;
      this.transition(transaction, "DECLINED", "payment.declined", "provider", { reason: result.reason });
      session.status = "completed";
    } else if (result.outcome === "cancelled") {
      this.transition(transaction, "CANCELLED", "payment.cancelled", "terminal", { signal });
      session.status = "cancelled";
    } else if (result.outcome === "provider_failure") {
      transaction.processorReference = result.reference;
      this.transition(transaction, "FAILED", "payment.failed", "provider", { reason: result.reason });
      session.status = "completed";
    } else if (result.outcome === "timeout") {
      this.transition(transaction, "UNKNOWN", "payment.unknown", "provider", { reason: "timeout" });
    } else {
      transaction.processorReference = result.reference;
      this.transition(transaction, "UNKNOWN", "payment.unknown", "provider", {
        reference: result.reference,
        charged: result.charged,
        reason: "transport_error",
      });
    }

    this.audit(input.actor, "payment.authorize", "transaction", transaction.id, {
      signal,
      status: transaction.status,
    });
    this.touchTerminal(terminal);
    this.finishIdempotency("authorize", input.idempotencyKey);
    return this.view(transaction);
  }

  cancelSession(input: { actor: Actor; sessionId: string }): TransactionView {
    const session = this.store.sessions.get(input.sessionId);
    if (!session) throw new AppError("NOT_FOUND", "Payment session not found.", 404);
    const terminal = this.requireTerminal(session.terminalId);
    this.assertActorTerminal(input.actor, terminal);
    const transaction = this.mustTransaction(session.transactionId);
    if (transaction.status === "CANCELLED") return this.view(transaction);
    this.transition(transaction, "CANCELLED", "payment.cancelled", "terminal", {});
    session.status = "cancelled";
    this.audit(input.actor, "payment.cancelled", "transaction", transaction.id, {});
    return this.view(transaction);
  }

  async resolve(input: { actor: Actor; transactionId: string }): Promise<TransactionView> {
    const transaction = this.mustTransaction(input.transactionId);
    this.assertCanRead(input.actor, transaction);
    if (!transaction.processorReference || transaction.processor === "cash") return this.view(transaction);
    if (transaction.status !== "UNKNOWN" && transaction.status !== "PROCESSING" && transaction.status !== "AUTHORIZED") {
      return this.view(transaction);
    }
    const status = await this.provider.getStatus(transaction.processorReference);
    if (!status) return this.view(transaction);
    this.applyProviderSnapshot(transaction, status.status, status.amount, status.currency);
    this.audit(input.actor, "payment.resolve", "transaction", transaction.id, { status: transaction.status });
    return this.view(transaction);
  }

  async refund(input: {
    actor: Actor;
    transactionId: string;
    amount: unknown;
    reason: unknown;
    idempotencyKey: string;
  }): Promise<TransactionView> {
    if (input.actor.role !== "ADMIN" && input.actor.role !== "FINANCE" && input.actor.role !== "SUPER_ADMIN") {
      throw new AppError("FORBIDDEN", "Refunds require a finance or admin role.", 403);
    }
    const transaction = this.mustTransaction(input.transactionId);
    const amount = assertAmount(input.amount);
    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    if (reason.length < 3) throw new AppError("VALIDATION", "A refund reason is required.", 400);
    const remaining = transaction.amount - transaction.refundedAmount;
    if (amount > remaining) {
      throw new AppError("VALIDATION", "Refund amount exceeds the remaining captured amount.", 400);
    }
    if (transaction.status !== "COMPLETED" && transaction.status !== "PARTIALLY_REFUNDED") {
      throw new AppError("CONFLICT", "Only a completed payment can be refunded.", 409);
    }

    const hash = requestHash({ transactionId: transaction.id, amount, reason });
    const replay = this.beginIdempotency("refund", input.idempotencyKey, hash, transaction.id);
    if (replay) return this.mustView(replay);

    let processorReference: string | null = null;
    if (transaction.processor !== "cash") {
      if (!transaction.processorReference) {
        this.releaseIdempotency("refund", input.idempotencyKey);
        throw new AppError("CONFLICT", "This payment has no provider reference to refund.", 409);
      }
      const result = await this.provider.refund({
        transactionId: transaction.id,
        reference: transaction.processorReference,
        amount,
        currency: transaction.currency,
        remainingAfter: remaining - amount,
      });
      if (result.outcome === "failed") {
        this.releaseIdempotency("refund", input.idempotencyKey);
        throw new AppError("PROVIDER_REFUND_FAILED", result.reason, 502);
      }
      processorReference = result.reference;
    }

    transaction.refundedAmount += amount;
    const next = transaction.refundedAmount === transaction.amount ? "REFUNDED" : "PARTIALLY_REFUNDED";
    this.transition(transaction, next, "payment.refunded", "admin", { amount, reason });
    const order = this.store.orders.get(transaction.orderId);
    if (order) order.paymentStatus = next === "REFUNDED" ? "refunded" : "partial";

    const refund: Refund = {
      id: this.store.next("RFD-"),
      transactionId: transaction.id,
      amount,
      reason,
      processorReference,
      status: "completed",
      createdAt: this.timestamp(),
    };
    this.store.refunds.push(refund);
    this.audit(input.actor, "refund.created", "refund", refund.id, { transactionId: transaction.id, amount });
    this.finishIdempotency("refund", input.idempotencyKey);
    return this.view(transaction);
  }

  ingestWebhook(raw: string, signature: string | undefined, actorId = "webhook"): { duplicate: boolean; transaction: TransactionView | null } {
    this.verifySignature(raw, signature);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new AppError("VALIDATION", "Webhook body must be JSON.", 400);
    }
    if (!body || typeof body !== "object") throw new AppError("VALIDATION", "Webhook body must be an object.", 400);
    const record = body as Record<string, unknown>;
    const externalId = typeof record.id === "string" ? record.id : "";
    const eventType = typeof record.type === "string" ? record.type : "";
    const data = record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : null;
    if (!externalId || !eventType || !data) {
      throw new AppError("VALIDATION", "Webhook requires id, type, and data.", 400);
    }
    const reference = typeof data.reference === "string" ? data.reference : "";
    const amount = data.amount;
    const currency = data.currency;
    if (!reference || typeof amount !== "number" || typeof currency !== "string") {
      throw new AppError("VALIDATION", "Webhook data requires reference, amount, and currency.", 400);
    }

    const duplicate = this.store.webhooks.some((item) => item.provider === this.provider.name && item.externalId === externalId);
    if (duplicate) {
      const transaction = this.findByReference(reference);
      return { duplicate: true, transaction: transaction ? this.view(transaction) : null };
    }

    this.store.webhooks.push({
      id: this.store.next("WH-"),
      provider: this.provider.name,
      externalId,
      eventType,
      payload: record as Record<string, unknown>,
      processed: false,
      receivedAt: this.timestamp(),
    });

    const transaction = this.findByReference(reference);
    if (!transaction) {
      this.audit({ id: actorId, role: "ADMIN", terminalId: null, merchantId: null }, "webhook.unmatched", "webhook", externalId, {
        reference,
        eventType,
      });
      return { duplicate: false, transaction: null };
    }

    if (amount !== transaction.amount || currency !== transaction.currency) {
      this.recordEvent(transaction, "payment.mismatch", "webhook", { amount, currency, eventType });
      this.audit({ id: actorId, role: "ADMIN", terminalId: null, merchantId: null }, "webhook.amount_mismatch", "transaction", transaction.id, {
        amount,
        currency,
      });
      throw new AppError("AMOUNT_MISMATCH", "Webhook amount does not match the Red Face transaction.", 409);
    }

    const providerStatus = eventType === "payment.completed"
      ? "success"
      : eventType === "payment.failed"
        ? "failed"
        : eventType === "payment.declined"
          ? "declined"
          : eventType === "payment.authorized"
            ? "authorized"
            : null;
    if (!providerStatus) throw new AppError("VALIDATION", `Unsupported webhook type ${eventType}.`, 400);

    if (providerStatus === "authorized") {
      if (transaction.status === "UNKNOWN" || transaction.status === "PROCESSING") {
        this.transition(transaction, "AUTHORIZED", "payment.authorized", "webhook", { reference });
      }
    } else {
      this.applyProviderSnapshot(transaction, providerStatus, amount, currency);
    }

    const stored = this.store.webhooks.find((item) => item.externalId === externalId);
    if (stored) stored.processed = true;
    this.audit({ id: actorId, role: "ADMIN", terminalId: null, merchantId: null }, "webhook.processed", "transaction", transaction.id, {
      eventType,
    });
    return { duplicate: false, transaction: this.view(transaction) };
  }

  listTransactions(actor: Actor, filters: { terminalId?: string; status?: string }): TransactionView[] {
    let rows = [...this.store.transactions.values()];
    if (actor.role === "TERMINAL") {
      rows = rows.filter((row) => row.terminalId === actor.terminalId);
    } else if (actor.merchantId && actor.role === "MERCHANT") {
      rows = rows.filter((row) => row.merchantId === actor.merchantId);
    }
    if (filters.terminalId) rows = rows.filter((row) => row.terminalId === filters.terminalId);
    if (filters.status) rows = rows.filter((row) => row.status === filters.status);
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return rows.map((row) => this.view(row));
  }

  getTransaction(actor: Actor, id: string): TransactionView {
    const transaction = this.mustTransaction(id);
    this.assertCanRead(actor, transaction);
    return this.view(transaction);
  }

  listTerminals(actor: Actor): Array<Record<string, unknown>> {
    if (actor.role === "TERMINAL") {
      const terminal = actor.terminalId ? this.store.terminals.get(actor.terminalId) : undefined;
      return terminal ? [this.terminalView(terminal, false)] : [];
    }
    return [...this.store.terminals.values()].map((terminal) => this.terminalView(terminal, true));
  }

  heartbeat(input: { actor: Actor; terminalId: string; online: boolean; ackCommand?: boolean }): Record<string, unknown> {
    const terminal = this.requireTerminal(input.terminalId);
    this.assertActorTerminal(input.actor, terminal);
    terminal.lastSeen = this.timestamp();
    const job = this.activeJob(terminal.id);
    if (terminal.status !== "LOCKED" && terminal.status !== "DISABLED") {
      if (job && input.online && terminal.config.auto_update) terminal.status = "UPDATING";
      else if (!job || !terminal.config.auto_update) terminal.status = input.online ? "ONLINE" : "OFFLINE";
    }
    if (input.ackCommand && terminal.pendingCommand?.status === "queued") {
      terminal.pendingCommand = { ...terminal.pendingCommand, status: "acked" };
      this.audit(input.actor, "terminal.command_acked", "terminal", terminal.id, {
        command: terminal.pendingCommand.action,
      });
      this.log(terminal.id, "info", `Acknowledged ${terminal.pendingCommand.action}.`);
    }
    if (input.online) this.advanceUpdate(terminal);
    return this.terminalView(terminal, false);
  }

  command(input: { actor: Actor; terminalId: string; action: string }): Record<string, unknown> {
    if (input.actor.role !== "ADMIN" && input.actor.role !== "OPERATIONS" && input.actor.role !== "SUPER_ADMIN") {
      throw new AppError("FORBIDDEN", "Terminal commands require an operations or admin role.", 403);
    }
    const terminal = this.requireTerminal(input.terminalId);
    if (input.action === "lock") terminal.status = "LOCKED";
    else if (input.action === "unlock") terminal.status = "ONLINE";
    else if (input.action === "disable") terminal.status = "DISABLED";
    else if (input.action === "enable") terminal.status = "ONLINE";
    else if (input.action === "restart") {
      terminal.pendingCommand = { id: this.store.next("CMD-"), action: input.action, status: "queued" };
    } else if (input.action === "revoke") {
      terminal.status = "DISABLED";
      terminal.pairingCode = null;
      for (const [token, actor] of this.store.deviceTokens) {
        if (actor.terminalId === terminal.id) this.store.deviceTokens.delete(token);
      }
      for (const device of this.store.devices.values()) {
        if (device.terminalId === terminal.id) device.securityStatus = "revoked";
      }
    } else if (input.action === "update") {
      throw new AppError("VALIDATION", "Publish a software release instead of a bare update command.", 400);
    } else {
      throw new AppError("VALIDATION", "Unknown terminal command.", 400);
    }
    this.audit(input.actor, `terminal.${input.action}`, "terminal", terminal.id, {});
    this.log(terminal.id, "info", `Command ${input.action} accepted.`);
    return this.terminalView(terminal, true);
  }

  updateConfig(input: { actor: Actor; terminalId: string; patch: Record<string, unknown> }): TerminalConfig {
    if (input.actor.role !== "ADMIN" && input.actor.role !== "OPERATIONS" && input.actor.role !== "SUPER_ADMIN") {
      throw new AppError("FORBIDDEN", "Configuration changes require an operations or admin role.", 403);
    }
    const terminal = this.requireTerminal(input.terminalId);
    const next = { ...terminal.config };
    const booleans = ["receipt_enabled", "cash_enabled", "qr_enabled", "contactless_enabled", "card_enabled", "auto_update"] as const;
    for (const key of booleans) {
      if (key in input.patch) {
        if (typeof input.patch[key] !== "boolean") throw new AppError("VALIDATION", `${key} must be boolean.`, 400);
        next[key] = input.patch[key];
      }
    }
    if ("idle_timeout" in input.patch) {
      const value = input.patch.idle_timeout;
      if (typeof value !== "number" || !Number.isInteger(value) || value < 15 || value > 3600) {
        throw new AppError("VALIDATION", "idle_timeout must be an integer from 15 to 3600 seconds.", 400);
      }
      next.idle_timeout = value;
    }
    terminal.config = next;
    this.audit(input.actor, "terminal.config", "terminal", terminal.id, { ...next });
    this.log(terminal.id, "info", "Remote configuration applied.");
    return next;
  }

  registerTerminal(input: { actor: Actor; location: unknown; deviceModel: unknown }): Record<string, unknown> {
    if (input.actor.role !== "ADMIN" && input.actor.role !== "OPERATIONS" && input.actor.role !== "SUPER_ADMIN") {
      throw new AppError("FORBIDDEN", "Terminal registration requires an operations or admin role.", 403);
    }
    const location = typeof input.location === "string" ? input.location.trim() : "";
    const deviceModel = typeof input.deviceModel === "string" ? input.deviceModel.trim() : "";
    if (location.length < 2 || deviceModel.length < 2) {
      throw new AppError("VALIDATION", "Location and device model are required.", 400);
    }
    const now = this.timestamp();
    const id = this.store.next("RF-TERM-");
    const pairingCode = randomBytes(4).toString("hex");
    const terminal: Terminal = {
      id,
      merchantId: input.actor.merchantId ?? "mer_demo",
      terminalSerial: `SIM-${id.slice(-6)}`,
      deviceModel,
      firmwareVersion: "sim-0",
      softwareVersion: "1.0.4",
      status: "OFFLINE",
      location,
      lastSeen: null,
      registeredAt: now,
      config: {
        currency: "ZAR",
        receipt_enabled: true,
        cash_enabled: true,
        qr_enabled: true,
        contactless_enabled: true,
        card_enabled: true,
        auto_update: true,
        idle_timeout: 60,
      },
      pendingCommand: null,
      pairingCode,
    };
    this.store.terminals.set(id, terminal);
    this.audit(input.actor, "terminal.registered", "terminal", id, { location });
    this.log(id, "info", "Terminal registered. Waiting for pairing.");
    return this.terminalView(terminal, true);
  }

  pairTerminal(code: string): { device_token: string; terminal_id: string } {
    const normalized = code.trim().toLowerCase();
    const terminal = [...this.store.terminals.values()].find((item) => item.pairingCode === normalized);
    if (!terminal) throw new AppError("NOT_FOUND", "Pairing code was not found.", 404);
    const token = `dt_${randomBytes(16).toString("hex")}`;
    terminal.pairingCode = null;
    this.store.deviceTokens.set(token, {
      id: terminal.id,
      role: "TERMINAL",
      terminalId: terminal.id,
      merchantId: terminal.merchantId,
    });
    this.log(terminal.id, "info", "Terminal paired.");
    return { device_token: token, terminal_id: terminal.id };
  }

  publishRelease(input: {
    actor: Actor;
    terminalId: string;
    version: unknown;
    notes: unknown;
    failHealth?: boolean;
    corrupt?: boolean;
  }): Record<string, unknown> {
    if (input.actor.role !== "ADMIN" && input.actor.role !== "OPERATIONS" && input.actor.role !== "SUPER_ADMIN") {
      throw new AppError("FORBIDDEN", "Software releases require an operations or admin role.", 403);
    }
    if ((input.failHealth || input.corrupt) && this.config.faultInjection === false) {
      throw new AppError("FORBIDDEN", "Fault injection is disabled.", 403);
    }
    const version = typeof input.version === "string" ? input.version.trim() : "";
    const notes = typeof input.notes === "string" ? input.notes.trim() : "";
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      throw new AppError("VALIDATION", "Version must look like 1.0.5.", 400);
    }
    if (notes.length < 3) throw new AppError("VALIDATION", "Release notes are required.", 400);
    const terminal = this.requireTerminal(input.terminalId);
    if (terminal.status === "LOCKED" || terminal.status === "DISABLED") {
      throw new AppError("CONFLICT", "A locked or disabled terminal cannot take an update.", 409);
    }
    if (this.activeJob(terminal.id)) {
      throw new AppError("CONFLICT", "This terminal already has an update in progress.", 409);
    }
    const sha256 = requestHash({ notes, version });
    const now = this.timestamp();
    const release = {
      id: this.store.next("REL-"),
      version,
      sha256,
      notes,
      createdAt: now,
    };
    this.store.releases.set(release.id, release);
    const job: UpdateJob = {
      id: this.store.next("UPD-"),
      terminalId: terminal.id,
      releaseId: release.id,
      version,
      previousVersion: terminal.softwareVersion,
      sha256: input.corrupt ? "0".repeat(64) : sha256,
      status: "UPDATE_DETECTED",
      failHealth: input.failHealth === true,
      createdAt: now,
      updatedAt: now,
    };
    this.store.updateJobs.push(job);
    if (terminal.status === "ONLINE" && terminal.config.auto_update) terminal.status = "UPDATING";
    this.audit(input.actor, "release.published", "terminal", terminal.id, { version, jobId: job.id });
    this.log(terminal.id, "info", `Release ${version} queued.`);
    return this.terminalView(terminal, true);
  }

  listLogs(actor: Actor, terminalId: string): Array<{ id: string; level: string; message: string; timestamp: string }> {
    const terminal = this.requireTerminal(terminalId);
    if (actor.role === "TERMINAL" && actor.terminalId !== terminal.id) {
      throw new AppError("FORBIDDEN", "This terminal cannot read those logs.", 403);
    }
    return this.store.logs
      .filter((entry) => entry.terminalId === terminal.id)
      .slice(-40)
      .map((entry) => ({
        id: entry.id,
        level: entry.level,
        message: entry.message,
        timestamp: entry.timestamp,
      }));
  }

  listMerchants(actor: Actor): Array<Record<string, unknown>> {
    if (actor.role === "TERMINAL") throw new AppError("FORBIDDEN", "Terminals cannot list merchants.", 403);
    const merchants = [...this.store.merchants.values()];
    return merchants.map((merchant) => this.merchantView(actor, merchant.id));
  }

  getMerchant(actor: Actor, merchantId: string): Record<string, unknown> {
    if (actor.role === "TERMINAL") throw new AppError("FORBIDDEN", "Terminals cannot read merchants.", 403);
    if (!this.store.merchants.has(merchantId)) throw new AppError("NOT_FOUND", "Merchant not found.", 404);
    return this.merchantView(actor, merchantId);
  }

  getTerminalDetail(actor: Actor, terminalId: string): Record<string, unknown> {
    const terminal = this.requireTerminal(terminalId);
    if (actor.role === "TERMINAL" && actor.terminalId !== terminal.id) {
      throw new AppError("FORBIDDEN", "This terminal cannot read that detail.", 403);
    }
    const base = this.terminalView(terminal, actor.role !== "TERMINAL");
    const job = this.latestJob(terminal.id);
    const device = [...this.store.devices.values()].find((item) => item.terminalId === terminal.id);
    const lastSeenMs = terminal.lastSeen ? Date.parse(terminal.lastSeen) : null;
    const heartbeatAge = lastSeenMs === null ? null : Math.max(0, Math.round((this.now().getTime() - lastSeenMs) / 1000));
    const audits = this.store.audits
      .filter((entry) => entry.resource === "terminal" && entry.resourceId === terminal.id)
      .slice(-20)
      .map((entry) => ({
        timestamp: entry.timestamp,
        action: entry.action,
        actor_id: entry.actorId,
        metadata: entry.metadata,
      }));
    const logs = this.listLogs(actor, terminal.id);
    return {
      ...base,
      health: {
        network: terminal.status === "OFFLINE" ? "OFFLINE" : "ONLINE",
        application: terminal.status === "DISABLED" ? "REVOKED" : terminal.status === "LOCKED" ? "LOCKED" : "HEALTHY",
        backend: "CONNECTED",
        battery_percent: 82,
        last_heartbeat_seconds: heartbeatAge,
        security_status: device?.securityStatus ?? "sandbox",
      },
      software: {
        current_version: terminal.softwareVersion,
        update_status: job?.status ?? "Up to date",
        available_version: job && isActiveUpdate(job.status) ? job.version : null,
        previous_version: job?.previousVersion ?? null,
      },
      audit: audits,
      logs,
    };
  }

  private merchantView(actor: Actor, merchantId: string): Record<string, unknown> {
    const merchant = this.store.merchants.get(merchantId);
    if (!merchant) throw new AppError("NOT_FOUND", "Merchant not found.", 404);
    const business = this.store.businesses.get(merchant.businessId);
    const terminals = [...this.store.terminals.values()].filter((item) => item.merchantId === merchantId);
    const merchantActor: Actor = {
      id: actor.id,
      role: "MERCHANT",
      terminalId: null,
      merchantId,
    };
    const overview = this.overview(merchantActor);
    const scoped = this.listTransactions(merchantActor, {});
    return {
      id: merchant.id,
      business_id: merchant.businessId,
      business_name: business?.businessName ?? merchant.id,
      status: merchant.status,
      currency: business?.currency ?? "ZAR",
      country: business?.country ?? "ZA",
      terminals: terminals.map((item) => ({
        id: item.id,
        status: item.status,
        location: item.location,
        software_version: item.softwareVersion,
        last_seen: item.lastSeen,
      })),
      today: {
        volume: overview.volume,
        volume_display: overview.volume_display,
        transactions: overview.transactions,
        successful: overview.successful,
      },
      recent_transactions: scoped.slice(0, 10),
    };
  }

  overview(actor: Actor): Record<string, unknown> {
    const rows = this.listTransactions(actor, {});
    const start = this.timestamp().slice(0, 10);
    const today = rows.filter((row) => row.created_at.slice(0, 10) === start);
    const successful = today.filter((row) =>
      row.status === "COMPLETED" || row.status === "PARTIALLY_REFUNDED" || row.status === "REFUNDED",
    );
    const volume = successful.reduce((sum, row) => sum + row.amount, 0);
    const terminals = [...this.store.terminals.values()];
    return {
      currency: "ZAR",
      volume,
      volume_display: formatZar(volume),
      transactions: today.length,
      successful: successful.length,
      failed: today.filter((row) => row.status === "FAILED" || row.status === "DECLINED").length,
      refunded: today.filter((row) => row.refunded_amount > 0).length,
      unknown: today.filter((row) => row.status === "UNKNOWN").length,
      terminals: {
        online: terminals.filter((item) => item.status === "ONLINE").length,
        offline: terminals.filter((item) => item.status === "OFFLINE").length,
        updating: terminals.filter((item) => item.status === "UPDATING").length,
        locked: terminals.filter((item) => item.status === "LOCKED").length,
        disabled: terminals.filter((item) => item.status === "DISABLED").length,
      },
    };
  }

  settlements(actor: Actor): Record<string, unknown> {
    const rows = this.listTransactions(actor, {}).filter((row) =>
      row.status === "COMPLETED" || row.status === "PARTIALLY_REFUNDED" || row.status === "REFUNDED",
    );
    const gross = rows.reduce((sum, row) => sum + row.amount, 0);
    const refunds = rows.reduce((sum, row) => sum + row.refunded_amount, 0);
    const fees = feeCents(gross);
    const tomorrow = new Date(this.now().getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return {
      gross,
      gross_display: formatZar(gross),
      fees,
      fees_display: formatZar(fees),
      refunds,
      refunds_display: formatZar(refunds),
      net: gross - fees - refunds,
      net_display: formatZar(gross - fees - refunds),
      settlement_date: tomorrow,
      provider_reference: "sandbox-batch",
      fee_policy: "Sandbox fee is 2.50% of captured gross and is not returned on refund.",
    };
  }

  reconciliation(): ReconReport {
    const locals = [...this.store.transactions.values()].map((row) => ({
      id: row.id,
      amount: row.amount,
      currency: row.currency,
      status: row.status,
      processor: row.processor,
      processorReference: row.processorReference,
      refundedAmount: row.refundedAmount,
    }));
    return reconcile(locals, this.provider.listCharges());
  }

  providerCharges(): ProviderCharge[] {
    return this.provider.listCharges();
  }

  private completeCash(transaction: Transaction): void {
    this.transition(transaction, "PROCESSING", "payment.processing", "terminal", { method: "cash" });
    this.transition(transaction, "AUTHORIZED", "payment.authorized", "terminal", { method: "cash" });
    this.markCompleted(transaction, null);
  }

  private markCompleted(transaction: Transaction, session: PaymentSession | null): void {
    this.transition(transaction, "COMPLETED", "payment.completed", "engine", {});
    const order = this.store.orders.get(transaction.orderId);
    if (order) order.paymentStatus = "paid";
    if (session) session.status = "completed";
    const linked = transaction.sessionId ? this.store.sessions.get(transaction.sessionId) : undefined;
    if (linked && linked !== session) linked.status = "completed";
  }

  private applyProviderSnapshot(
    transaction: Transaction,
    providerStatus: string,
    amount: number,
    currency: string,
  ): void {
    if (amount !== transaction.amount || currency !== transaction.currency) {
      this.recordEvent(transaction, "payment.mismatch", "provider", { amount, currency, providerStatus });
      return;
    }
    const session = transaction.sessionId ? this.store.sessions.get(transaction.sessionId) ?? null : null;
    if (providerStatus === "success") {
      if (transaction.status === "PROCESSING") {
        this.transition(transaction, "AUTHORIZED", "payment.authorized", "provider", { resolved: true });
      }
      if (transaction.status === "AUTHORIZED") {
        this.markCompleted(transaction, session);
        return;
      }
      if (transaction.status === "UNKNOWN") {
        this.transition(transaction, "COMPLETED", "payment.completed", "provider", { resolved: true });
        const order = this.store.orders.get(transaction.orderId);
        if (order) order.paymentStatus = "paid";
        if (session) session.status = "completed";
      }
      return;
    }
    if (
      providerStatus === "failed" &&
      (transaction.status === "UNKNOWN" || transaction.status === "PROCESSING" || transaction.status === "AUTHORIZED")
    ) {
      this.transition(transaction, "FAILED", "payment.failed", "provider", {});
    }
    if (providerStatus === "declined" && (transaction.status === "UNKNOWN" || transaction.status === "PROCESSING")) {
      this.transition(transaction, "DECLINED", "payment.declined", "provider", {});
    }
  }

  private transition(
    transaction: Transaction,
    next: TransactionStatus,
    eventType: string,
    source: string,
    payload: Record<string, unknown> = {},
  ): void {
    assertTransition(transaction.status, next);
    transaction.status = next;
    if (
      (next === "COMPLETED" || next === "FAILED" || next === "DECLINED" || next === "CANCELLED") &&
      !transaction.completedAt
    ) {
      transaction.completedAt = this.timestamp();
    }
    this.recordEvent(transaction, eventType, source, payload);
  }

  private recordEvent(
    transaction: Transaction,
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
  ): PaymentEvent {
    const event: PaymentEvent = {
      id: this.store.next("EVT-"),
      transactionId: transaction.id,
      eventType,
      payload,
      source,
      timestamp: this.timestamp(),
      processed: true,
    };
    this.store.events.push(event);
    return event;
  }

  private beginIdempotency(scope: string, key: string, hash: string, transactionId: string | null): string | null {
    if (!key || key.length < 8 || key.length > 120) {
      throw new AppError("VALIDATION", "Idempotency-Key must be between 8 and 120 characters.", 400);
    }
    const id = this.store.idempotencyId(scope, key);
    const current = this.store.idempotency.get(id);
    if (current) {
      if (current.hash !== hash) {
        throw new AppError("IDEMPOTENCY_CONFLICT", "This idempotency key was already used for a different request.", 409);
      }
      if (current.state !== "done" || !current.transactionId) {
        throw new AppError("IDEMPOTENCY_IN_PROGRESS", "This request is still in progress.", 409);
      }
      return current.transactionId;
    }
    this.store.idempotency.set(id, {
      scope,
      key,
      hash,
      state: "pending",
      transactionId,
      createdAt: this.timestamp(),
    });
    return null;
  }

  private finishIdempotencyLink(scope: string, key: string, transactionId: string): void {
    const record = this.store.idempotency.get(this.store.idempotencyId(scope, key));
    if (record) record.transactionId = transactionId;
  }

  private finishIdempotency(scope: string, key: string): void {
    const record = this.store.idempotency.get(this.store.idempotencyId(scope, key));
    if (record) record.state = "done";
  }

  private releaseIdempotency(scope: string, key: string): void {
    this.store.idempotency.delete(this.store.idempotencyId(scope, key));
  }

  private verifySignature(raw: string, signature: string | undefined): void {
    if (!signature) throw new AppError("UNAUTHORIZED", "Missing webhook signature.", 401);
    const expected = createHmac("sha256", this.config.webhookSecret).update(raw).digest("hex");
    const left = Buffer.from(signature);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      throw new AppError("UNAUTHORIZED", "Webhook signature is invalid.", 401);
    }
  }

  private requireTerminal(id: string): Terminal {
    const terminal = this.store.terminals.get(id);
    if (!terminal) throw new AppError("NOT_FOUND", "Terminal not found.", 404);
    return terminal;
  }

  private mustTransaction(id: string): Transaction {
    const transaction = this.store.transactions.get(id);
    if (!transaction) throw new AppError("NOT_FOUND", "Transaction not found.", 404);
    return transaction;
  }

  private mustView(id: string): TransactionView {
    return this.view(this.mustTransaction(id));
  }

  private findByReference(reference: string): Transaction | undefined {
    return [...this.store.transactions.values()].find((row) => row.processorReference === reference);
  }

  private assertTerminalCanSell(actor: Actor, terminal: Terminal, method: PaymentMethod): void {
    this.assertActorTerminal(actor, terminal);
    if (terminal.status === "LOCKED" || terminal.status === "DISABLED") {
      throw new AppError("TERMINAL_LOCKED", "This terminal cannot take payments.", 423);
    }
    if (CARD_METHODS.has(method) && terminal.status !== "ONLINE") {
      throw new AppError("NETWORK_UNAVAILABLE", "Card payments unavailable. Cash sale available.", 409);
    }
  }

  private assertActorTerminal(actor: Actor, terminal: Terminal): void {
    if (actor.role === "TERMINAL" && actor.terminalId !== terminal.id) {
      throw new AppError("FORBIDDEN", "This device token is not paired to that terminal.", 403);
    }
  }

  private assertCanRead(actor: Actor, transaction: Transaction): void {
    if (actor.role === "TERMINAL" && actor.terminalId !== transaction.terminalId) {
      throw new AppError("FORBIDDEN", "This terminal cannot read that transaction.", 403);
    }
  }

  private assertMethodEnabled(terminal: Terminal, method: PaymentMethod): void {
    const config = terminal.config;
    if (method === "cash" && !config.cash_enabled) throw new AppError("VALIDATION", "Cash is disabled on this terminal.", 409);
    if (method === "card" && !config.card_enabled) throw new AppError("VALIDATION", "Card is disabled on this terminal.", 409);
    if (method === "tap" && !config.contactless_enabled) throw new AppError("VALIDATION", "Tap is disabled on this terminal.", 409);
    if (method === "qr" && !config.qr_enabled) throw new AppError("VALIDATION", "QR is disabled on this terminal.", 409);
  }

  private touchTerminal(terminal: Terminal): void {
    terminal.lastSeen = this.timestamp();
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private view(transaction: Transaction): TransactionView {
    const merchant = this.store.merchants.get(transaction.merchantId);
    const business = merchant ? this.store.businesses.get(merchant.businessId) : undefined;
    const terminal = this.store.terminals.get(transaction.terminalId);
    const events = this.store.events
      .filter((event) => event.transactionId === transaction.id)
      .map((event) => ({
        id: event.id,
        event_type: event.eventType,
        source: event.source,
        timestamp: event.timestamp,
        payload: event.payload,
      }));
    const approved = transaction.status === "COMPLETED" || transaction.status === "PARTIALLY_REFUNDED" || transaction.status === "REFUNDED";
    const receipt = approved && terminal?.config.receipt_enabled
      ? [
          "PAY",
          business?.businessName ?? "Merchant",
          terminal?.location ?? "",
          "",
          transaction.paymentMethod.toUpperCase(),
          formatZar(transaction.amount),
          transaction.status,
          "",
          transaction.id,
          transaction.authorizationCode ? `Auth ${transaction.authorizationCode}` : "",
          transaction.processorReference ? `Ref ${transaction.processorReference}` : "",
        ].filter((line) => line !== "").join("\n")
      : null;
    return {
      id: transaction.id,
      merchant_id: transaction.merchantId,
      merchant_name: business?.businessName ?? transaction.merchantId,
      terminal_id: transaction.terminalId,
      terminal_location: terminal?.location ?? "",
      order_id: transaction.orderId,
      session_id: transaction.sessionId,
      amount: transaction.amount,
      amount_display: formatZar(transaction.amount),
      currency: transaction.currency,
      payment_method: transaction.paymentMethod,
      processor: transaction.processor,
      processor_reference: transaction.processorReference,
      status: transaction.status,
      authorization_code: transaction.authorizationCode,
      refunded_amount: transaction.refundedAmount,
      refunded_display: formatZar(transaction.refundedAmount),
      created_at: transaction.createdAt,
      completed_at: transaction.completedAt,
      events,
      receipt,
    };
  }

  private terminalView(terminal: Terminal, includePairing: boolean): Record<string, unknown> {
    const merchant = this.store.merchants.get(terminal.merchantId);
    const business = merchant ? this.store.businesses.get(merchant.businessId) : undefined;
    const job = this.latestJob(terminal.id);
    return {
      id: terminal.id,
      merchant_id: terminal.merchantId,
      merchant_name: business?.businessName ?? terminal.merchantId,
      terminal_serial: terminal.terminalSerial,
      device_model: terminal.deviceModel,
      firmware_version: terminal.firmwareVersion,
      software_version: terminal.softwareVersion,
      status: terminal.status,
      location: terminal.location,
      last_seen: terminal.lastSeen,
      registered_at: terminal.registeredAt,
      config: terminal.config,
      pending_command: terminal.pendingCommand,
      pairing_code: includePairing ? terminal.pairingCode : null,
      update_job: job
        ? {
            id: job.id,
            version: job.version,
            previous_version: job.previousVersion,
            status: job.status,
          }
        : null,
    };
  }

  private activeJob(terminalId: string): UpdateJob | undefined {
    return [...this.store.updateJobs].reverse().find((job) => job.terminalId === terminalId && isActiveUpdate(job.status));
  }

  private latestJob(terminalId: string): UpdateJob | undefined {
    return [...this.store.updateJobs].reverse().find((job) => job.terminalId === terminalId);
  }

  private advanceUpdate(terminal: Terminal): void {
    const job = this.activeJob(terminal.id);
    if (!job || !terminal.config.auto_update) return;
    const now = this.timestamp();
    if (job.status === "UPDATE_DETECTED") {
      return this.markJob(job, terminal, "DOWNLOADING", `Downloading ${job.version}.`, now);
    }
    if (job.status === "DOWNLOADING") {
      return this.markJob(job, terminal, "DOWNLOADED", `Downloaded ${job.version}.`, now);
    }
    if (job.status === "DOWNLOADED") {
      return this.markJob(job, terminal, "VERIFYING", `Verifying ${job.version}.`, now);
    }
    if (job.status === "VERIFYING") {
      const release = this.store.releases.get(job.releaseId);
      const actual = release ? requestHash({ notes: release.notes, version: release.version }) : "";
      if (actual !== job.sha256) {
        return this.finishUpdate(
          job,
          terminal,
          "ROLLED_BACK",
          `Package hash for ${job.version} did not match. Rolled back to ${job.previousVersion}.`,
          now,
        );
      }
      return this.markJob(job, terminal, "VERIFIED", `Verified ${job.version}.`, now);
    }
    if (job.status === "VERIFIED") {
      return this.markJob(job, terminal, "INSTALLING", `Installing ${job.version}.`, now);
    }
    if (job.status === "INSTALLING") {
      return this.markJob(job, terminal, "HEALTH_CHECK", `Health check for ${job.version}.`, now);
    }
    if (job.status === "HEALTH_CHECK") {
      if (job.failHealth) {
        return this.finishUpdate(
          job,
          terminal,
          "ROLLED_BACK",
          `Health check failed for ${job.version}. Rolled back to ${job.previousVersion}.`,
          now,
        );
      }
      terminal.softwareVersion = job.version;
      return this.finishUpdate(job, terminal, "COMPLETED", `Update ${job.version} completed.`, now);
    }
  }

  private markJob(job: UpdateJob, terminal: Terminal, status: UpdateJob["status"], message: string, now: string): void {
    assertUpdateTransition(job.status, status);
    job.status = status;
    job.updatedAt = now;
    if (terminal.status !== "LOCKED" && terminal.status !== "DISABLED") terminal.status = "UPDATING";
    this.log(terminal.id, "info", message);
  }

  private finishUpdate(job: UpdateJob, terminal: Terminal, status: "COMPLETED" | "ROLLED_BACK", message: string, now: string): void {
    assertUpdateTransition(job.status, status);
    job.status = status;
    job.updatedAt = now;
    if (terminal.status === "UPDATING") terminal.status = "ONLINE";
    this.log(terminal.id, status === "COMPLETED" ? "info" : "warn", message);
  }

  private log(terminalId: string, level: "info" | "warn", message: string): void {
    this.store.logs.push({
      id: this.store.next("LOG-"),
      terminalId,
      level,
      message,
      timestamp: this.timestamp(),
    });
  }

  audits(): AuditLog[] {
    return this.store.audits;
  }

  private audit(actor: Actor, action: string, resource: string, resourceId: string, metadata: Record<string, unknown>): void {
    this.store.audits.push({
      id: this.store.next("AUD-"),
      actorId: actor.id,
      action,
      resource,
      resourceId,
      metadata,
      timestamp: this.timestamp(),
    });
  }
}
