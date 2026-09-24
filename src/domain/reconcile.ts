import type { TransactionStatus } from "./state-machine.ts";

export type ReconLocal = {
  id: string;
  amount: number;
  currency: string;
  status: TransactionStatus;
  processor: string;
  processorReference: string | null;
  refundedAmount: number;
};

export type ReconCharge = {
  reference: string;
  amount: number;
  currency: string;
  status: "success" | "refunded" | "partially_refunded";
  transactionId: string | null;
  refundedAmount: number;
};

export type ReconState =
  | "MATCHED"
  | "MISSING_PROVIDER"
  | "MISSING_REDFACE"
  | "AMOUNT_MISMATCH"
  | "STATUS_MISMATCH"
  | "DUPLICATE"
  | "UNKNOWN";

export type ReconException = {
  state: Exclude<ReconState, "MATCHED">;
  transaction_id: string | null;
  reference: string | null;
  detail: string;
};

export type ReconReport = {
  provider_count: number;
  redface_count: number;
  matched: number;
  difference: number;
  exceptions: ReconException[];
};

const SETTLED = new Set<TransactionStatus>([
  "PROCESSING",
  "AUTHORIZED",
  "COMPLETED",
  "UNKNOWN",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
]);

function statusCompatible(status: TransactionStatus, charge: ReconCharge): boolean {
  if (charge.status === "success") return status === "COMPLETED" || status === "AUTHORIZED";
  if (charge.status === "refunded") return status === "REFUNDED" && charge.refundedAmount === charge.amount;
  if (charge.status === "partially_refunded") {
    return status === "PARTIALLY_REFUNDED" && charge.refundedAmount > 0;
  }
  return false;
}

export function reconcile(locals: ReconLocal[], charges: ReconCharge[]): ReconReport {
  const cardLocals = locals.filter((row) => row.processor !== "cash" && row.status !== "CREATED" && row.status !== "INITIATED" && row.status !== "CANCELLED");
  const byReference = new Map<string, ReconLocal[]>();
  for (const row of cardLocals) {
    if (!row.processorReference) continue;
    const list = byReference.get(row.processorReference) ?? [];
    list.push(row);
    byReference.set(row.processorReference, list);
  }

  const exceptions: ReconException[] = [];
  let matched = 0;
  const seenReferences = new Set<string>();

  for (const row of cardLocals) {
    if (!row.processorReference) {
      if (row.status === "FAILED" || row.status === "DECLINED") {
        matched += 1;
        continue;
      }
      exceptions.push({
        state: "UNKNOWN",
        transaction_id: row.id,
        reference: null,
        detail: `${row.id} is ${row.status} and has no provider reference.`,
      });
      continue;
    }

    const group = byReference.get(row.processorReference) ?? [];
    if (group.length > 1) {
      if (!seenReferences.has(row.processorReference)) {
        seenReferences.add(row.processorReference);
        exceptions.push({
          state: "DUPLICATE",
          transaction_id: row.id,
          reference: row.processorReference,
          detail: `Reference ${row.processorReference} is linked to ${group.length} Red Face transactions.`,
        });
      }
      continue;
    }
    seenReferences.add(row.processorReference);

    const charge = charges.find((item) => item.reference === row.processorReference);
    if (!charge) {
      if (row.status === "FAILED" || row.status === "DECLINED") {
        matched += 1;
        continue;
      }
      exceptions.push({
        state: "MISSING_PROVIDER",
        transaction_id: row.id,
        reference: row.processorReference,
        detail: `${row.id} has reference ${row.processorReference}, which the provider ledger does not contain.`,
      });
      continue;
    }
    if (charge.amount !== row.amount || charge.currency !== row.currency) {
      exceptions.push({
        state: "AMOUNT_MISMATCH",
        transaction_id: row.id,
        reference: row.processorReference,
        detail: `Red Face ${row.amount} ${row.currency} vs provider ${charge.amount} ${charge.currency}.`,
      });
      continue;
    }
    if (!statusCompatible(row.status, charge)) {
      exceptions.push({
        state: "STATUS_MISMATCH",
        transaction_id: row.id,
        reference: row.processorReference,
        detail: `Red Face is ${row.status}; provider is ${charge.status}.`,
      });
      continue;
    }
    matched += 1;
  }

  for (const charge of charges) {
    if (seenReferences.has(charge.reference) || byReference.has(charge.reference)) continue;
    exceptions.push({
      state: "MISSING_REDFACE",
      transaction_id: charge.transactionId,
      reference: charge.reference,
      detail: `Provider charge ${charge.reference} has no Red Face transaction.`,
    });
  }

  const redfaceCount = cardLocals.filter((row) => SETTLED.has(row.status)).length;

  return {
    provider_count: charges.length,
    redface_count: redfaceCount,
    matched,
    difference: exceptions.length,
    exceptions,
  };
}
