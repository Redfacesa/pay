import { AppError } from "./errors.ts";

export const SERVICE_TYPES = ["AIRTIME", "DATA", "ELECTRICITY", "VAS", "SMS"] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export const SERVICE_STATUSES = [
  "CREATED",
  "SUBMITTED",
  "PENDING",
  "COMPLETED",
  "FAILED",
  "PROVIDER_ERROR",
  "TIMEOUT",
] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

const TRANSITIONS: Record<ServiceStatus, readonly ServiceStatus[]> = {
  CREATED: ["SUBMITTED", "FAILED", "PROVIDER_ERROR"],
  SUBMITTED: ["PENDING", "COMPLETED", "FAILED", "PROVIDER_ERROR", "TIMEOUT"],
  PENDING: ["COMPLETED", "FAILED", "PROVIDER_ERROR", "TIMEOUT"],
  COMPLETED: [],
  FAILED: [],
  PROVIDER_ERROR: [],
  TIMEOUT: ["PENDING", "COMPLETED", "FAILED"],
};

export function assertServiceTransition(from: ServiceStatus, to: ServiceStatus): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new AppError("ILLEGAL_SERVICE_TRANSITION", `Cannot move a service order from ${from} to ${to}.`, 409);
  }
}

export type ServiceSimulation =
  | "success"
  | "pending"
  | "failed"
  | "timeout"
  | "duplicate"
  | "provider_error"
  | "insufficient_balance";

export function assertSimulation(value: unknown): ServiceSimulation {
  if (
    value === "success" ||
    value === "pending" ||
    value === "failed" ||
    value === "timeout" ||
    value === "duplicate" ||
    value === "provider_error" ||
    value === "insufficient_balance"
  ) {
    return value;
  }
  return "success";
}
