import { AppError } from "./errors.ts";
import type { UpdateStatus } from "./types.ts";

/**
 * Software update lifecycle on a terminal.
 * A release is never installed merely because it exists.
 */
export const UPDATE_TRANSITIONS: Record<UpdateStatus, readonly UpdateStatus[]> = {
  UPDATE_DETECTED: ["DOWNLOADING"],
  DOWNLOADING: ["DOWNLOADED"],
  DOWNLOADED: ["VERIFYING"],
  VERIFYING: ["VERIFIED", "ROLLED_BACK"],
  VERIFIED: ["INSTALLING"],
  INSTALLING: ["HEALTH_CHECK"],
  HEALTH_CHECK: ["COMPLETED", "ROLLED_BACK"],
  COMPLETED: [],
  ROLLED_BACK: [],
};

export function canAdvanceUpdate(from: UpdateStatus, to: UpdateStatus): boolean {
  return UPDATE_TRANSITIONS[from].includes(to);
}

export function assertUpdateTransition(from: UpdateStatus, to: UpdateStatus): void {
  if (!canAdvanceUpdate(from, to)) {
    throw new AppError(
      "ILLEGAL_UPDATE_TRANSITION",
      `Cannot move an update from ${from} to ${to}.`,
      409,
      { from, to },
    );
  }
}

export function isActiveUpdate(status: UpdateStatus): boolean {
  return status !== "COMPLETED" && status !== "ROLLED_BACK";
}
