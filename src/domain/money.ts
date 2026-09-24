import { AppError } from "./errors.ts";

export const DEFAULT_CURRENCY = "ZAR";
export const SANDBOX_FEE_BPS = 250;
export const MAX_AMOUNT_CENTS = 100_000_000;

export function assertAmount(amount: unknown): number {
  if (typeof amount !== "number" || !Number.isInteger(amount)) {
    throw new AppError("VALIDATION", "Amount must be an integer number of cents.", 400);
  }
  if (amount < 1 || amount > MAX_AMOUNT_CENTS) {
    throw new AppError("VALIDATION", "Amount is outside the allowed range.", 400);
  }
  return amount;
}

export function assertCurrency(currency: unknown): string {
  if (currency !== DEFAULT_CURRENCY) {
    throw new AppError("VALIDATION", "Only ZAR is enabled in this build.", 400);
  }
  return currency;
}

export function feeCents(amount: number, bps = SANDBOX_FEE_BPS): number {
  return Math.round((amount * bps) / 10_000);
}

export function formatZar(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const rands = Math.floor(abs / 100);
  const rem = String(abs % 100).padStart(2, "0");
  const grouped = rands.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}R ${grouped}.${rem}`;
}
