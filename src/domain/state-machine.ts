import { AppError } from "./errors.ts";

export const TRANSACTION_STATUSES = [
  "CREATED",
  "INITIATED",
  "PROCESSING",
  "AUTHORIZED",
  "COMPLETED",
  "FAILED",
  "DECLINED",
  "CANCELLED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
  "UNKNOWN",
] as const;

export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

const TRANSITIONS: Record<TransactionStatus, readonly TransactionStatus[]> = {
  CREATED: ["INITIATED", "CANCELLED"],
  INITIATED: ["PROCESSING", "CANCELLED", "UNKNOWN"],
  PROCESSING: ["AUTHORIZED", "FAILED", "DECLINED", "CANCELLED", "UNKNOWN"],
  AUTHORIZED: ["COMPLETED", "FAILED", "UNKNOWN"],
  COMPLETED: ["REFUNDED", "PARTIALLY_REFUNDED"],
  PARTIALLY_REFUNDED: ["REFUNDED", "PARTIALLY_REFUNDED"],
  REFUNDED: [],
  FAILED: [],
  DECLINED: [],
  CANCELLED: [],
  UNKNOWN: ["PROCESSING", "AUTHORIZED", "COMPLETED", "FAILED", "DECLINED", "CANCELLED"],
};

export function canTransition(from: TransactionStatus, to: TransactionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TransactionStatus, to: TransactionStatus): void {
  if (!canTransition(from, to)) {
    throw new AppError(
      "ILLEGAL_TRANSITION",
      `Cannot move a transaction from ${from} to ${to}.`,
      409,
      { from, to },
    );
  }
}

export function isTerminalStatus(status: TransactionStatus): boolean {
  return TRANSITIONS[status].length === 0;
}
