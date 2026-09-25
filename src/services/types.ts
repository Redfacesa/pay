import type { ServiceSimulation, ServiceType } from "../domain/service-order.ts";

export type ServiceProduct = {
  id: string;
  service_type: ServiceType;
  network: string | null;
  group: string | null;
  name: string;
  amount: number;
  amount_display: string;
};

export type SubmitInput = {
  serviceType: ServiceType;
  amount: number;
  msisdn: string | null;
  meterNumber: string | null;
  productId: string | null;
  message: string | null;
  simulation: ServiceSimulation;
  idempotencyKey: string;
};

export type SubmitResult = {
  requestId: string;
  status: "completed" | "pending" | "failed" | "provider_error" | "timeout";
  providerReference: string | null;
  reason: string | null;
  voucher: string | null;
  units: string | null;
  network: string | null;
  cost: number | null;
};

export type PollResult = SubmitResult;

export type ServiceHealth = {
  provider: string;
  api: "ONLINE" | "OFFLINE";
  airtime: "ONLINE" | "OFFLINE";
  data: "ONLINE" | "OFFLINE";
  electricity: "ONLINE" | "OFFLINE";
  vas: "ONLINE" | "OFFLINE";
  sms: "ONLINE" | "OFFLINE";
  balance: number;
  balance_display: string;
};

/**
 * VAS rail. SIMcloud can implement this later.
 * The terminal never receives a provider token.
 */
export interface ServiceProvider {
  readonly name: string;
  health(): Promise<ServiceHealth>;
  lookupNetwork(msisdn: string): Promise<{ network: string }>;
  listProducts(serviceType: ServiceType): Promise<ServiceProduct[]>;
  checkMeter(meterNumber: string): Promise<{ valid: boolean; holder: string | null }>;
  submit(input: SubmitInput): Promise<SubmitResult>;
  poll(requestId: string): Promise<PollResult | null>;
}
