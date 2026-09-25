import { AppError } from "../domain/errors.ts";
import { formatZar } from "../domain/money.ts";
import type { ServiceType } from "../domain/service-order.ts";
import type { PollResult, ServiceHealth, ServiceProduct, ServiceProvider, SubmitInput, SubmitResult } from "./types.ts";

const MARGIN_BPS = 750;

type StoredRequest = SubmitResult & { amount: number; cost: number; serviceType: SubmitInput["serviceType"] };

/**
 * Development stand-in for SIMcloud.
 * Same submit-then-poll shape. No live token and no real wallet spend.
 */
export class ServiceSimulator implements ServiceProvider {
  readonly name = "simulator";
  private balance = 1_000_000;
  private sequence = 0;
  private requests = new Map<string, StoredRequest>();
  private byKey = new Map<string, string>();

  constructor(paymentEnv: string) {
    if (paymentEnv === "production") {
      throw new AppError("SIMULATOR_FORBIDDEN", "The service simulator cannot run in production.", 500);
    }
  }

  async health(): Promise<ServiceHealth> {
    return {
      provider: this.name,
      api: "ONLINE",
      airtime: "ONLINE",
      data: "ONLINE",
      electricity: "ONLINE",
      vas: "ONLINE",
      sms: "ONLINE",
      balance: this.balance,
      balance_display: formatZar(this.balance),
    };
  }

  async lookupNetwork(msisdn: string): Promise<{ network: string }> {
    const prefix = msisdn.slice(0, 3);
    const map: Record<string, string> = {
      "083": "MTN",
      "073": "MTN",
      "082": "VODACOM",
      "072": "VODACOM",
      "084": "CELLC",
      "074": "CELLC",
      "081": "TELKOM",
    };
    return { network: map[prefix] ?? "MTN" };
  }

  async listProducts(serviceType: ServiceType): Promise<ServiceProduct[]> {
    if (serviceType === "DATA") {
      return [
        product("dat_mtn_1gb", "DATA", "MTN", "MTN 1GB", 2900),
        product("dat_voda_1gb", "DATA", "VODACOM", "Vodacom 1GB", 3500),
        product("dat_cellc_1gb", "DATA", "CELLC", "Cell C 1GB", 2500),
      ];
    }
    if (serviceType === "VAS") {
      return [
        product("vas_stream_day", "VAS", null, "Streaming day pass", 1500),
        product("vas_game_10", "VAS", null, "Game voucher R10", 1000),
      ];
    }
    return [];
  }

  async checkMeter(meterNumber: string): Promise<{ valid: boolean; holder: string | null }> {
    if (!/^\d{8,13}$/.test(meterNumber) || meterNumber.startsWith("0")) {
      return { valid: false, holder: null };
    }
    return { valid: true, holder: "Sandbox meter" };
  }

  async submit(input: SubmitInput): Promise<SubmitResult> {
    const existing = this.byKey.get(input.idempotencyKey);
    if (existing) {
      const stored = this.requests.get(existing);
      if (stored) return stored;
    }
    if (input.simulation === "duplicate" && this.requests.size > 0) {
      const first = [...this.requests.values()][0];
      if (first) return first;
    }
    const requestId = `SIM-${String(++this.sequence).padStart(6, "0")}`;
    const result = await this.resolve(input, requestId);
    const cost = providerCost(input.amount);
    if ((result.status === "completed" || result.status === "pending") && this.balance < cost) {
      const denied = failed(requestId, "insufficient_balance", "Simulator wallet balance is too low.");
      this.requests.set(requestId, { ...denied, amount: input.amount, cost, serviceType: input.serviceType });
      this.byKey.set(input.idempotencyKey, requestId);
      return denied;
    }
    if (result.status === "completed") this.balance -= cost;
    this.requests.set(requestId, { ...result, amount: input.amount, cost, serviceType: input.serviceType });
    this.byKey.set(input.idempotencyKey, requestId);
    return result;
  }

  async poll(requestId: string): Promise<PollResult | null> {
    const stored = this.requests.get(requestId);
    if (!stored) return null;
    if (stored.status !== "pending") return stored;
    this.balance -= stored.cost;
    const voucher = stored.serviceType === "ELECTRICITY" || stored.serviceType === "VAS" ? "1234 5678 9012 3456" : null;
    const units = stored.serviceType === "ELECTRICITY" ? `${(stored.amount / 100 / 2.8).toFixed(2)} kWh` : null;
    const completed: StoredRequest = {
      ...stored,
      status: "completed",
      providerReference: `SIMCLOUD-${requestId}`,
      voucher,
      units,
      reason: null,
    };
    this.requests.set(requestId, completed);
    return completed;
  }

  private async resolve(input: SubmitInput, requestId: string): Promise<SubmitResult> {
    const network = input.msisdn ? (await this.lookupNetwork(input.msisdn)).network : null;
    if (input.simulation === "insufficient_balance" || this.balance < providerCost(input.amount)) {
      return failed(requestId, "insufficient_balance", "Simulator wallet balance is too low.");
    }
    if (input.simulation === "provider_error") {
      return failed(requestId, "provider_error", "Service provider is unavailable.");
    }
    if (input.simulation === "failed") {
      return failed(requestId, "failed", "The service provider declined the order.");
    }
    if (input.simulation === "timeout") {
      return {
        requestId,
        status: "timeout",
        providerReference: null,
        reason: "The service provider did not respond.",
        voucher: null,
        units: null,
        network,
        cost: null,
      };
    }
    const voucher = input.serviceType === "ELECTRICITY" || input.serviceType === "VAS" ? "1234 5678 9012 3456" : null;
    const units = input.serviceType === "ELECTRICITY" ? `${(input.amount / 100 / 2.8).toFixed(2)} kWh` : null;
    if (input.simulation === "pending") {
      return {
        requestId,
        status: "pending",
        providerReference: null,
        reason: null,
        voucher: null,
        units: null,
        network,
        cost: null,
      };
    }
    return {
      requestId,
      status: "completed",
      providerReference: `SIMCLOUD-${requestId}`,
      reason: null,
      voucher,
      units,
      network,
      cost: null,
    };
  }
}

function providerCost(amount: number): number {
  const margin = Math.round((amount * MARGIN_BPS) / 10_000);
  return amount - margin;
}

function product(id: string, serviceType: ServiceType, network: string | null, name: string, amount: number): ServiceProduct {
  return { id, service_type: serviceType, network, name, amount, amount_display: formatZar(amount) };
}

function failed(requestId: string, status: "failed" | "provider_error" | "insufficient_balance", reason: string): SubmitResult {
  return {
    requestId,
    status: status === "insufficient_balance" ? "failed" : status === "provider_error" ? "provider_error" : "failed",
    providerReference: null,
    reason,
    voucher: null,
    units: null,
    network: null,
    cost: null,
  };
}

export function quote(amount: number): { cost: number; margin: number } {
  const margin = Math.round((amount * MARGIN_BPS) / 10_000);
  return { cost: amount - margin, margin };
}

export function assertMsisdn(value: unknown): string {
  const digits = typeof value === "string" ? value.replace(/\s/g, "") : "";
  const local = digits.startsWith("27") ? `0${digits.slice(2)}` : digits;
  if (!/^0\d{9}$/.test(local)) throw new AppError("VALIDATION", "Enter a South African mobile number.", 400);
  return local;
}
