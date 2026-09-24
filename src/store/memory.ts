import type {
  AuditLog,
  Business,
  Device,
  IdempotencyRecord,
  MerchantAccount,
  Order,
  PaymentEvent,
  PaymentSession,
  Refund,
  SoftwareRelease,
  Terminal,
  TerminalLog,
  Transaction,
  UpdateJob,
  User,
  WebhookEvent,
} from "../domain/types.ts";
import type { Actor } from "../domain/types.ts";

export class MemoryStore {
  users = new Map<string, User>();
  businesses = new Map<string, Business>();
  merchants = new Map<string, MerchantAccount>();
  terminals = new Map<string, Terminal>();
  devices = new Map<string, Device>();
  orders = new Map<string, Order>();
  sessions = new Map<string, PaymentSession>();
  transactions = new Map<string, Transaction>();
  refunds: Refund[] = [];
  events: PaymentEvent[] = [];
  audits: AuditLog[] = [];
  webhooks: WebhookEvent[] = [];
  idempotency = new Map<string, IdempotencyRecord>();
  releases = new Map<string, SoftwareRelease>();
  updateJobs: UpdateJob[] = [];
  logs: TerminalLog[] = [];
  deviceTokens = new Map<string, Actor>();
  private sequences = new Map<string, number>();

  next(prefix: string, width = 6): string {
    const current = this.sequences.get(prefix) ?? 0;
    const value = current + 1;
    this.sequences.set(prefix, value);
    return `${prefix}${String(value).padStart(width, "0")}`;
  }

  setSequence(prefix: string, value: number): void {
    this.sequences.set(prefix, value);
  }

  idempotencyId(scope: string, key: string): string {
    return `${scope}:${key}`;
  }
}
