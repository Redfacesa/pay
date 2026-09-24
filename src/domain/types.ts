import type { TransactionStatus } from "./state-machine.ts";

export const ROLES = [
  "SUPER_ADMIN",
  "ADMIN",
  "OPERATIONS",
  "FINANCE",
  "SUPPORT",
  "MERCHANT",
  "TERMINAL",
] as const;

export type Role = (typeof ROLES)[number];

export const PAYMENT_METHODS = ["cash", "card", "tap", "qr"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const TERMINAL_STATUSES = ["ONLINE", "OFFLINE", "UPDATING", "LOCKED", "DISABLED"] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export const UPDATE_STATUSES = [
  "UPDATE_DETECTED",
  "DOWNLOADING",
  "DOWNLOADED",
  "VERIFYING",
  "VERIFIED",
  "INSTALLING",
  "HEALTH_CHECK",
  "COMPLETED",
  "ROLLED_BACK",
] as const;

export type UpdateStatus = (typeof UPDATE_STATUSES)[number];

export type SimulatorSignal =
  | "approve"
  | "decline"
  | "timeout"
  | "network_error"
  | "provider_failure"
  | "cancel";

export type TerminalConfig = {
  currency: "ZAR";
  receipt_enabled: boolean;
  cash_enabled: boolean;
  qr_enabled: boolean;
  contactless_enabled: boolean;
  card_enabled: boolean;
  auto_update: boolean;
  idle_timeout: number;
};

export type User = {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: Role;
  status: "active" | "disabled";
  createdAt: string;
};

export type Business = {
  id: string;
  ownerId: string;
  businessName: string;
  registrationNumber: string;
  status: "active" | "suspended";
  currency: "ZAR";
  country: string;
  createdAt: string;
};

export type MerchantAccount = {
  id: string;
  businessId: string;
  processorId: string;
  processorAccountId: string;
  settlementAccount: string;
  status: "active" | "pending" | "disabled";
};

export type Terminal = {
  id: string;
  merchantId: string;
  terminalSerial: string;
  deviceModel: string;
  firmwareVersion: string;
  softwareVersion: string;
  status: TerminalStatus;
  location: string;
  lastSeen: string | null;
  registeredAt: string;
  config: TerminalConfig;
  pendingCommand: null | { id: string; action: string; status: "queued" | "acked" };
  pairingCode: string | null;
};

export type SoftwareRelease = {
  id: string;
  version: string;
  sha256: string;
  notes: string;
  createdAt: string;
};

export type UpdateJob = {
  id: string;
  terminalId: string;
  releaseId: string;
  version: string;
  previousVersion: string;
  sha256: string;
  status: UpdateStatus;
  failHealth: boolean;
  createdAt: string;
  updatedAt: string;
};

export type TerminalLog = {
  id: string;
  terminalId: string;
  level: "info" | "warn";
  message: string;
  timestamp: string;
};

export type Device = {
  id: string;
  terminalId: string;
  hardwareId: string;
  osVersion: string;
  firmwareVersion: string;
  appVersion: string;
  securityStatus: "sandbox" | "revoked";
};

export type Order = {
  id: string;
  merchantId: string;
  customerId: string | null;
  subtotal: number;
  tax: number;
  discount: number;
  total: number;
  currency: "ZAR";
  paymentStatus: "unpaid" | "paid" | "partial" | "refunded";
  fulfillmentStatus: "not_applicable";
  createdAt: string;
};

export type PaymentSession = {
  id: string;
  merchantId: string;
  terminalId: string;
  orderId: string;
  transactionId: string;
  amount: number;
  currency: "ZAR";
  paymentMethod: PaymentMethod;
  provider: string;
  status: "open" | "processing" | "completed" | "expired" | "cancelled";
  expiresAt: string;
  createdAt: string;
};

export type Transaction = {
  id: string;
  merchantId: string;
  terminalId: string;
  orderId: string;
  sessionId: string | null;
  amount: number;
  currency: "ZAR";
  paymentMethod: PaymentMethod;
  processor: string;
  processorReference: string | null;
  status: TransactionStatus;
  authorizationCode: string | null;
  refundedAmount: number;
  idempotencyKey: string;
  createdAt: string;
  completedAt: string | null;
};

export type Refund = {
  id: string;
  transactionId: string;
  amount: number;
  reason: string;
  processorReference: string | null;
  status: "completed" | "failed";
  createdAt: string;
};

export type PaymentEvent = {
  id: string;
  transactionId: string;
  eventType: string;
  payload: Record<string, unknown>;
  source: string;
  timestamp: string;
  processed: boolean;
};

export type AuditLog = {
  id: string;
  actorId: string;
  action: string;
  resource: string;
  resourceId: string;
  metadata: Record<string, unknown>;
  timestamp: string;
};

export type IdempotencyRecord = {
  scope: string;
  key: string;
  hash: string;
  state: "pending" | "done";
  transactionId: string | null;
  createdAt: string;
};

export type WebhookEvent = {
  id: string;
  provider: string;
  externalId: string;
  eventType: string;
  payload: Record<string, unknown>;
  processed: boolean;
  receivedAt: string;
};

export type Actor = {
  id: string;
  role: Role;
  terminalId: string | null;
  merchantId: string | null;
};

export const DEFAULT_TERMINAL_CONFIG: TerminalConfig = {
  currency: "ZAR",
  receipt_enabled: true,
  cash_enabled: true,
  qr_enabled: true,
  contactless_enabled: true,
  card_enabled: true,
  auto_update: true,
  idle_timeout: 60,
};
