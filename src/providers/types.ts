export type ProviderName = "sandbox";

export type AuthorizeInput = {
  transactionId: string;
  amount: number;
  currency: string;
  idempotencyKey: string;
  signal: "approve" | "decline" | "timeout" | "network_error" | "provider_failure" | "cancel";
};

export type AuthorizeResult =
  | { outcome: "authorized"; reference: string; authorizationCode: string }
  | { outcome: "declined"; reference: string; reason: string }
  | { outcome: "timeout" }
  | { outcome: "transport_error"; reference: string | null; charged: boolean }
  | { outcome: "provider_failure"; reference: string; reason: string }
  | { outcome: "cancelled" };

export type CaptureInput = {
  transactionId: string;
  reference: string;
  amount: number;
  currency: string;
};

export type CaptureResult =
  | { outcome: "captured"; reference: string }
  | { outcome: "transport_error"; reference: string };

export type RefundInput = {
  transactionId: string;
  reference: string;
  amount: number;
  currency: string;
  remainingAfter: number;
};

export type RefundResult =
  | { outcome: "refunded"; reference: string; providerStatus: "refunded" | "partially_refunded" }
  | { outcome: "failed"; reason: string };

export type ProviderStatus = {
  reference: string;
  amount: number;
  currency: string;
  status: "success" | "failed" | "declined" | "unknown" | "refunded" | "partially_refunded";
  refundedAmount: number;
};

export type ProviderCharge = {
  reference: string;
  amount: number;
  currency: string;
  status: "success" | "refunded" | "partially_refunded";
  transactionId: string | null;
  refundedAmount: number;
};

/**
 * Acquirer/processor boundary. Terminal code and the order model call this
 * interface only. A later Paystack, bank, ISO, or acquirer adapter implements
 * the same methods. This build ships the sandbox adapter.
 */
export interface PaymentProvider {
  readonly name: ProviderName | string;
  authorize(input: AuthorizeInput): Promise<AuthorizeResult>;
  capture(input: CaptureInput): Promise<CaptureResult>;
  voidAuthorization(reference: string): Promise<void>;
  refund(input: RefundInput): Promise<RefundResult>;
  getStatus(reference: string): Promise<ProviderStatus | null>;
  listCharges(): ProviderCharge[];
}
