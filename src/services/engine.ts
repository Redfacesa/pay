import { AppError } from "../domain/errors.ts";
import { formatZar } from "../domain/money.ts";
import { assertServiceTransition, assertSimulation, type ServiceStatus, type ServiceType } from "../domain/service-order.ts";
import type { Actor } from "../domain/types.ts";
import { MemoryStore } from "../store/memory.ts";
import { assertMsisdn, quote } from "./simulator.ts";
import type { ServiceProvider } from "./types.ts";

export type ServiceOrder = {
  id: string;
  merchantId: string;
  terminalId: string;
  customerReference: string | null;
  serviceType: ServiceType;
  provider: string;
  productName: string | null;
  network: string | null;
  msisdn: string | null;
  meterNumber: string | null;
  amount: number;
  cost: number;
  margin: number;
  currency: "ZAR";
  status: ServiceStatus;
  providerReference: string | null;
  providerRequestId: string | null;
  voucher: string | null;
  units: string | null;
  failureReason: string | null;
  idempotencyKey: string;
  createdAt: string;
  completedAt: string | null;
};

export class ServiceEngine {
  private readonly store: MemoryStore;
  private readonly provider: ServiceProvider;
  private readonly now: () => Date;

  constructor(store: MemoryStore, provider: ServiceProvider, now: () => Date = () => new Date()) {
    this.store = store;
    this.provider = provider;
    this.now = now;
  }

  async lookup(actor: Actor, msisdn: unknown) {
    const number = assertMsisdn(msisdn);
    this.terminal(actor);
    return { msisdn: number, ...(await this.provider.lookupNetwork(number)) };
  }

  async products(actor: Actor, serviceType: ServiceType) {
    this.terminal(actor);
    return this.provider.listProducts(serviceType);
  }

  async checkMeter(actor: Actor, meterNumber: unknown) {
    this.terminal(actor);
    const meter = typeof meterNumber === "string" ? meterNumber.trim() : "";
    const result = await this.provider.checkMeter(meter);
    return { meter_number: meter, valid: result.valid, holder: result.holder };
  }

  async providerHealth(actor: Actor) {
    if (actor.role === "TERMINAL") throw new AppError("FORBIDDEN", "Terminals cannot read the provider wallet.", 403);
    return this.provider.health();
  }

  providerName(): string {
    return this.provider.name;
  }

  list(actor: Actor) {
    return [...this.store.serviceOrders.values()]
      .filter((order) => this.visible(actor, order))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((order) => this.view(order));
  }

  async create(
    actor: Actor,
    input: {
      serviceType: ServiceType;
      amount?: number;
      msisdn?: string;
      meterNumber?: string;
      productId?: string;
      message?: string;
      simulation?: unknown;
    },
    idempotencyKey: string,
  ) {
    const terminal = this.terminal(actor);
    if (terminal.status === "LOCKED" || terminal.status === "DISABLED") {
      throw new AppError("TERMINAL_LOCKED", "This terminal cannot sell services.", 403);
    }
    if (terminal.status === "OFFLINE") {
      throw new AppError("TERMINAL_OFFLINE", "Services need a network connection.", 403);
    }
    if (idempotencyKey.length < 8) throw new AppError("VALIDATION", "Idempotency-Key is required.", 400);
    const replay = [...this.store.serviceOrders.values()].find((order) => order.idempotencyKey === idempotencyKey);
    if (replay) return this.view(replay);

    const simulation = this.provider.name === "simulator" ? assertSimulation(input.simulation) : "success";
    const catalogue = input.productId ? await this.provider.listProducts(input.serviceType) : [];
    const product = catalogue.find((item) => item.id === input.productId);
    if ((input.serviceType === "DATA" || input.serviceType === "VAS") && !product) {
      throw new AppError("VALIDATION", "Choose a product from the catalogue.", 400);
    }
    const amount = product ? product.amount : Number(input.amount);
    if (!Number.isInteger(amount) || amount < 100) throw new AppError("VALIDATION", "Amount is too small.", 400);
    if (input.serviceType === "AIRTIME" && this.provider.name === "simcloud" && (amount < 200 || amount > 99_900)) {
      throw new AppError("VALIDATION", "Airtime must be between R2 and R999.", 400);
    }
    const msisdn = input.serviceType === "ELECTRICITY"
      ? input.msisdn
        ? assertMsisdn(input.msisdn)
        : null
      : assertMsisdn(input.msisdn);
    if (input.serviceType === "ELECTRICITY" && this.provider.name === "simcloud" && !msisdn) {
      throw new AppError("VALIDATION", "Enter the mobile number that should receive the voucher SMS.", 400);
    }
    const meter = input.serviceType === "ELECTRICITY" ? String(input.meterNumber ?? "").trim() : null;
    if (input.serviceType === "ELECTRICITY") {
      const checked = await this.provider.checkMeter(meter ?? "");
      if (!checked.valid) throw new AppError("METER_INVALID", "That meter number could not be validated.", 422);
    }
    if (input.serviceType === "SMS" && String(input.message ?? "").trim().length < 1) {
      throw new AppError("VALIDATION", "Enter an SMS message.", 400);
    }
    const money = quote(amount);
    const order: ServiceOrder = {
      id: this.store.next("RF-VAS-"),
      merchantId: terminal.merchantId,
      terminalId: terminal.id,
      customerReference: msisdn ?? meter,
      serviceType: input.serviceType,
      provider: this.provider.name,
      productName: product?.name ?? label(input.serviceType),
      network: product?.network ?? null,
      msisdn,
      meterNumber: meter,
      amount,
      cost: 0,
      margin: 0,
      currency: "ZAR",
      status: "CREATED",
      providerReference: null,
      providerRequestId: null,
      voucher: null,
      units: null,
      failureReason: null,
      idempotencyKey,
      createdAt: this.now().toISOString(),
      completedAt: null,
    };
    this.store.serviceOrders.set(order.id, order);
    const result = await this.provider.submit({
      serviceType: input.serviceType,
      amount,
      msisdn,
      meterNumber: meter,
      productId: product?.id ?? null,
      message: input.message ?? null,
      simulation,
      idempotencyKey,
    });
    assertServiceTransition(order.status, "SUBMITTED");
    order.status = "SUBMITTED";
    order.providerRequestId = result.requestId;
    if (result.network) order.network = result.network;
    this.apply(order, result.status, result.providerReference, result.reason, result.voucher, result.units, priced(amount, result.cost, money));
    return this.view(order);
  }

  async poll(actor: Actor, orderId: string) {
    const order = this.store.serviceOrders.get(orderId);
    if (!order || !this.visible(actor, order)) throw new AppError("NOT_FOUND", "Service order not found.", 404);
    if (!order.providerRequestId || order.status === "COMPLETED" || order.status === "FAILED" || order.status === "PROVIDER_ERROR") {
      return this.view(order);
    }
    const result = await this.provider.poll(order.providerRequestId);
    if (!result) return this.view(order);
    const money = quote(order.amount);
    if (result.network) order.network = result.network;
    this.apply(order, result.status, result.providerReference, result.reason, result.voucher, result.units, priced(order.amount, result.cost, money));
    return this.view(order);
  }

  private apply(
    order: ServiceOrder,
    status: "completed" | "pending" | "failed" | "provider_error" | "timeout",
    reference: string | null,
    reason: string | null,
    voucher: string | null,
    units: string | null,
    money: { cost: number; margin: number },
  ): void {
    const next: ServiceStatus =
      status === "completed"
        ? "COMPLETED"
        : status === "pending"
          ? "PENDING"
          : status === "timeout"
            ? "TIMEOUT"
            : status === "provider_error"
              ? "PROVIDER_ERROR"
              : "FAILED";
    if (order.status !== next) assertServiceTransition(order.status, next);
    order.status = next;
    order.providerReference = reference;
    order.failureReason = reason;
    order.voucher = voucher;
    order.units = units;
    if (next === "COMPLETED") {
      order.cost = money.cost;
      order.margin = money.margin;
      order.completedAt = this.now().toISOString();
    }
  }

  private terminal(actor: Actor) {
    if (actor.role !== "TERMINAL" || !actor.terminalId) throw new AppError("FORBIDDEN", "A terminal must sell the service.", 403);
    const terminal = this.store.terminals.get(actor.terminalId);
    if (!terminal) throw new AppError("NOT_FOUND", "Terminal not found.", 404);
    return terminal;
  }

  private visible(actor: Actor, order: ServiceOrder): boolean {
    if (actor.role === "ADMIN") return true;
    if (actor.role === "TERMINAL") return order.terminalId === actor.terminalId;
    return order.merchantId === actor.merchantId;
  }

  private view(order: ServiceOrder) {
    return {
      id: order.id,
      service_type: order.serviceType,
      provider: order.provider,
      product_name: order.productName,
      network: order.network,
      msisdn: order.msisdn,
      meter_number: order.meterNumber,
      amount: order.amount,
      amount_display: formatZar(order.amount),
      cost: order.cost,
      margin: order.margin,
      margin_display: formatZar(order.margin),
      currency: order.currency,
      status: order.status,
      provider_reference: order.providerReference,
      provider_request_id: order.providerRequestId,
      voucher: order.voucher,
      units: order.units,
      failure_reason: order.failureReason,
      created_at: order.createdAt,
    };
  }
}

function priced(amount: number, providerCost: number | null | undefined, fallback: { cost: number; margin: number }) {
  if (typeof providerCost !== "number") return fallback;
  return { cost: providerCost, margin: amount - providerCost };
}

function label(serviceType: ServiceType): string {
  if (serviceType === "AIRTIME") return "Airtime";
  if (serviceType === "SMS") return "SMS";
  if (serviceType === "ELECTRICITY") return "Electricity";
  return serviceType;
}
