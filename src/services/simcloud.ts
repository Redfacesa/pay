import { formatZar } from "../domain/money.ts";
import type { ServiceType } from "../domain/service-order.ts";
import type { PollResult, ServiceHealth, ServiceProduct, ServiceProvider, SubmitInput, SubmitResult } from "./types.ts";

const BASE = "https://simcloud.co.za/api";

type Json = Record<string, unknown>;

type CachedProduct = {
  service: ServiceType;
  networkCode: string;
  displayNetwork: string | null;
  amountCents: number;
  name: string;
};

/**
 * Server-side SIMcloud adapter. The token never leaves this process.
 * Purchases debit the live wallet. Balance and catalogue calls do not.
 */
export class SimcloudProvider implements ServiceProvider {
  readonly name = "simcloud";
  private readonly token: string;
  private catalogue = new Map<string, CachedProduct>();
  private healthCache: { at: number; value: ServiceHealth } | null = null;

  constructor(token: string) {
    this.token = token.trim();
  }

  async health(): Promise<ServiceHealth> {
    const cached = this.healthCache;
    if (cached && Date.now() - cached.at < 15_000) return cached.value;
    try {
      const { http, body } = await this.call("balance.php");
      if (http === 401 || body.status === "error") return offline();
      const balance = cents(body.balance);
      const value: ServiceHealth = {
        provider: this.name,
        api: "ONLINE",
        airtime: "ONLINE",
        data: "ONLINE",
        electricity: "ONLINE",
        vas: "ONLINE",
        sms: "ONLINE",
        balance,
        balance_display: formatZar(balance),
      };
      this.healthCache = { at: Date.now(), value };
      return value;
    } catch {
      return offline();
    }
  }

  async lookupNetwork(msisdn: string): Promise<{ network: string }> {
    const { body } = await this.call(`network.php?msisdn=${encodeURIComponent(msisdn)}`);
    return { network: displayNetwork(String(body.network ?? "")) };
  }

  async listProducts(serviceType: ServiceType): Promise<ServiceProduct[]> {
    if (serviceType === "DATA") return this.dataProducts();
    if (serviceType === "VAS") return this.vasProducts();
    return [];
  }

  async checkMeter(meterNumber: string): Promise<{ valid: boolean; holder: string | null }> {
    const meter = meterNumber.replace(/[\s-]/g, "");
    try {
      const { body } = await this.call(`electricity.php?meter_number=${encodeURIComponent(meter)}`);
      const supported = body.supported === true || body.status === "success";
      const holder = typeof body.provider === "string" ? body.provider : null;
      return { valid: supported, holder };
    } catch {
      return { valid: false, holder: null };
    }
  }

  async submit(input: SubmitInput): Promise<SubmitResult> {
    try {
      if (input.serviceType === "AIRTIME") return await this.submitAirtime(input);
      if (input.serviceType === "DATA") return await this.submitData(input);
      if (input.serviceType === "VAS") return await this.submitVas(input);
      if (input.serviceType === "ELECTRICITY") return await this.submitElectricity(input);
      return await this.submitSms(input);
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      return blank(input.serviceType, timedOut ? "timeout" : "provider_error", timedOut ? "SIMcloud did not respond." : "SIMcloud could not be reached.");
    }
  }

  async poll(requestId: string): Promise<PollResult | null> {
    const split = requestId.indexOf(":");
    if (split < 1) return null;
    const service = requestId.slice(0, split);
    const id = requestId.slice(split + 1);
    try {
      if (service === "airtime") return this.fromQueue(await this.call(`airtime.php?request_id=${encodeURIComponent(id)}`), requestId, "AIRTIME");
      if (service === "data") return this.fromQueue(await this.call(`data.php?request_id=${encodeURIComponent(id)}`), requestId, "DATA");
      if (service === "vas") return this.fromVas(await this.call(`vas.php?order_id=${encodeURIComponent(id)}`), requestId);
      if (service === "electricity") return this.fromElectricity(await this.call(`electricity.php?order_id=${encodeURIComponent(id)}`), requestId);
      if (service === "sms") return this.fromSms(await this.call(`sms.php?sms_id=${encodeURIComponent(id)}`), requestId);
      return null;
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      return blank("AIRTIME", timedOut ? "timeout" : "provider_error", timedOut ? "SIMcloud did not respond." : "SIMcloud could not be reached.", requestId);
    }
  }

  private async submitAirtime(input: SubmitInput): Promise<SubmitResult> {
    const network = displayNetwork((await this.lookupNetwork(input.msisdn ?? "")).network);
    const { http, body } = await this.call("airtime.php", {
      msisdn: input.msisdn,
      network: airtimeCode(network),
      amount: rands(input.amount),
      reference: input.idempotencyKey.slice(0, 80),
    });
    return this.fromQueue({ http, body }, `airtime:${body.request_id ?? ""}`, "AIRTIME", network);
  }

  private async submitData(input: SubmitInput): Promise<SubmitResult> {
    const product = await this.cached(input.productId, "DATA");
    const { http, body } = await this.call("data.php", {
      msisdn: input.msisdn,
      network: product?.networkCode,
      amount: rands(product?.amountCents ?? input.amount),
      reference: input.idempotencyKey.slice(0, 80),
    });
    return this.fromQueue({ http, body }, `data:${body.request_id ?? ""}`, "DATA", product?.displayNetwork ?? null);
  }

  private async submitVas(input: SubmitInput): Promise<SubmitResult> {
    const product = await this.cached(input.productId, "VAS");
    const productId = Number(String(input.productId ?? "").split("-")[2] ?? "");
    const { http, body } = await this.call("vas.php", {
      product_id: Number.isInteger(productId) ? productId : undefined,
      amount: rands(product?.amountCents ?? input.amount),
      reference: input.idempotencyKey.slice(0, 80),
    });
    const requestId = `vas:${body.order_id ?? ""}`;
    return this.fromVas({ http, body }, requestId);
  }

  private async submitElectricity(input: SubmitInput): Promise<SubmitResult> {
    const { http, body } = await this.call("electricity.php", {
      meter_number: input.meterNumber,
      amount: rands(input.amount),
      client_reference: input.idempotencyKey.slice(0, 40),
      recipient: input.msisdn,
      send_sms: true,
      sms_company_name: "Red Face",
    });
    return this.fromElectricity({ http, body }, `electricity:${body.order_id ?? ""}`);
  }

  private async submitSms(input: SubmitInput): Promise<SubmitResult> {
    const local = input.msisdn ?? "";
    const recipient = local.startsWith("0") ? `+27${local.slice(1)}` : local;
    const { http, body } = await this.call("sms.php", {
      recipient,
      message: (input.message ?? "").slice(0, 459),
    });
    return this.fromSms({ http, body }, `sms:${body.sms_id ?? ""}`);
  }

  private async dataProducts(): Promise<ServiceProduct[]> {
    const { body } = await this.call("data.php?products=1");
    const rows = Array.isArray(body.products) ? body.products : [];
    const products: ServiceProduct[] = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const item = row as Json;
      const amount = cents(item.sellvalue ?? item.amount);
      const id = `sc-data-${item.product_id}`;
      const display = displayNetwork(String(item.network_name ?? item.network ?? ""));
      this.catalogue.set(id, {
        service: "DATA",
        networkCode: String(item.network ?? ""),
        displayNetwork: display,
        amountCents: amount,
        name: String(item.description ?? "Data"),
      });
      products.push({
        id,
        service_type: "DATA",
        network: display,
        name: `${display} ${item.description ?? "Data"}`,
        amount,
        amount_display: formatZar(amount),
      });
    }
    return products;
  }

  private async vasProducts(): Promise<ServiceProduct[]> {
    const { body } = await this.call("vas.php");
    const rows = Array.isArray(body.products) ? body.products : [];
    const products: ServiceProduct[] = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const item = row as Json;
      const amounts = Array.isArray(item.available_amounts) ? item.available_amounts : [item.default_amount];
      for (const value of amounts) {
        const amount = cents(value);
        const id = `sc-vas-${item.product_id}-${amount}`;
        const name = String(item.voucher_type ?? "Voucher");
        this.catalogue.set(id, {
          service: "VAS",
          networkCode: "",
          displayNetwork: null,
          amountCents: amount,
          name,
        });
        products.push({
          id,
          service_type: "VAS",
          network: null,
          name,
          amount,
          amount_display: formatZar(amount),
        });
      }
    }
    return products;
  }

  private async cached(productId: string | null, service: ServiceType): Promise<CachedProduct | null> {
    if (!productId) return null;
    const found = this.catalogue.get(productId);
    if (found) return found;
    await this.listProducts(service);
    return this.catalogue.get(productId) ?? null;
  }

  private fromQueue(response: { http: number; body: Json }, requestId: string, service: ServiceType, network: string | null = null): SubmitResult {
    const body = response.body;
    const id = body.request_id ?? requestId.split(":")[1];
    const mapped = mapStatus(response.http, body, false);
    const billed = cents(body.amount);
    return {
      requestId: id ? `${service === "DATA" ? "data" : "airtime"}:${id}` : requestId,
      status: mapped,
      providerReference: body.platform_order_number ? `SIMCLOUD-${body.platform_order_number}` : id ? `SIMCLOUD-${id}` : null,
      reason: mapped === "completed" ? null : messageOf(body),
      voucher: null,
      units: null,
      network: network ?? displayNetwork(String(body.network ?? "")),
      cost: mapped === "failed" || mapped === "provider_error" ? null : billed,
    };
  }

  private fromVas(response: { http: number; body: Json }, requestId: string): SubmitResult {
    const body = response.body;
    const id = body.order_id ?? requestId.split(":")[1];
    const vouchers = Array.isArray(body.vouchers) ? body.vouchers : [];
    const first = vouchers[0] && typeof vouchers[0] === "object" ? (vouchers[0] as Json) : null;
    const mapped = mapStatus(response.http, body, Boolean(first));
    return {
      requestId: id ? `vas:${id}` : requestId,
      status: mapped,
      providerReference: body.transaction_id ? `SIMCLOUD-${body.transaction_id}` : id ? `SIMCLOUD-${id}` : null,
      reason: mapped === "completed" ? null : messageOf(body),
      voucher: first ? String(first.voucher_code ?? "") : null,
      units: null,
      network: null,
      cost: mapped === "failed" || mapped === "provider_error" ? null : cents(body.total_billed_amount ?? body.amount),
    };
  }

  private fromElectricity(response: { http: number; body: Json }, requestId: string): SubmitResult {
    const body = response.body;
    const id = body.order_id ?? requestId.split(":")[1];
    const pins = Array.isArray(body.recharge_pin_information) ? body.recharge_pin_information : [];
    const first = pins[0] && typeof pins[0] === "object" ? (pins[0] as Json) : null;
    const mapped = mapStatus(response.http, body, Boolean(first));
    return {
      requestId: id ? `electricity:${id}` : requestId,
      status: mapped,
      providerReference: body.order_reference_id ? `SIMCLOUD-${body.order_reference_id}` : id ? `SIMCLOUD-${id}` : null,
      reason: mapped === "completed" ? null : messageOf(body),
      voucher: first ? String(first.pin ?? "") : null,
      units: first?.units ? `${first.units} kWh` : null,
      network: null,
      cost: mapped === "failed" || mapped === "provider_error" ? null : cents(body.amount),
    };
  }

  private fromSms(response: { http: number; body: Json }, requestId: string): SubmitResult {
    const body = response.body;
    const id = body.sms_id ?? requestId.split(":")[1];
    const mapped = mapStatus(response.http, body, String(body.status).toLowerCase() === "delivered" || String(body.status).toLowerCase() === "sent");
    return {
      requestId: id ? `sms:${id}` : requestId,
      status: mapped,
      providerReference: id ? `SIMCLOUD-${id}` : null,
      reason: mapped === "completed" ? null : messageOf(body),
      voucher: null,
      units: null,
      network: null,
      cost: null,
    };
  }

  private async call(path: string, json?: Json): Promise<{ http: number; body: Json }> {
    const response = await fetch(`${BASE}/${path}`, {
      method: json ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/json",
        ...(json ? { "content-type": "application/json" } : {}),
      },
      body: json ? JSON.stringify(json) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    let body: Json = {};
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Json;
    } catch {
      body = { status: "error", message: "SIMcloud returned an unreadable response." };
    }
    return { http: response.status, body };
  }
}

function mapStatus(http: number, body: Json, hasVoucher: boolean): SubmitResult["status"] {
  if (http === 401) return "provider_error";
  const status = String(body.status ?? "").toLowerCase();
  const queue = String(body.queue_status ?? body.process_status ?? body.final_order_status ?? "").toLowerCase();
  const text = String(body.message ?? "").toLowerCase();
  if (http === 409 || text.includes("duplicate") || text.includes("insufficient")) return "failed";
  if (status === "delivered" || status === "sent" || hasVoucher || queue === "delivered" || queue === "completed") return "completed";
  if (status === "failed" || status === "cancelled" || status === "unsupported" || queue === "failed" || queue === "cancelled") return "failed";
  if (status === "error") return http >= 500 ? "provider_error" : "failed";
  if (status === "queued" || status === "pending" || status === "staged" || status === "unknown" || status === "success") return "pending";
  if (http >= 500) return "provider_error";
  return "failed";
}

function messageOf(body: Json): string | null {
  const message = body.message ?? body.error ?? body.result_message;
  return typeof message === "string" && message.length > 0 ? message : null;
}

function rands(cents: number): number {
  return Math.round(cents) / 100;
}

function cents(value: unknown): number {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100);
}

function displayNetwork(value: string): string {
  const network = value.toLowerCase();
  if (network.includes("vodacom")) return "VODACOM";
  if (network.includes("cell")) return "CELLC";
  if (network.includes("telkom") || network.includes("heita")) return "TELKOM";
  if (network.includes("mtn")) return "MTN";
  return value ? value.toUpperCase() : "MTN";
}

function airtimeCode(network: string): string {
  if (network === "VODACOM") return "p-vodacom";
  if (network === "CELLC") return "p-cellc";
  if (network === "TELKOM") return "p-heita";
  return "p-mtn";
}

function offline(): ServiceHealth {
  return {
    provider: "simcloud",
    api: "OFFLINE",
    airtime: "OFFLINE",
    data: "OFFLINE",
    electricity: "OFFLINE",
    vas: "OFFLINE",
    sms: "OFFLINE",
    balance: 0,
    balance_display: formatZar(0),
  };
}

function blank(service: ServiceType, status: SubmitResult["status"], reason: string, requestId = `${service.toLowerCase()}:`): SubmitResult {
  return {
    requestId,
    status,
    providerReference: null,
    reason,
    voucher: null,
    units: null,
    network: null,
    cost: null,
  };
}
