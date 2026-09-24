import { AppError } from "../domain/errors.ts";
import type {
  AuthorizeInput,
  AuthorizeResult,
  CaptureInput,
  CaptureResult,
  PaymentProvider,
  ProviderCharge,
  ProviderStatus,
  RefundInput,
  RefundResult,
} from "./types.ts";

/**
 * Sandbox acquirer. It never sees a PAN, PIN, or CVV.
 * `network_error` records a successful charge and then reports that the
 * response was lost — the case where the terminal and the bank disagree.
 */
export class SandboxProvider implements PaymentProvider {
  readonly name = "sandbox";
  private readonly charges = new Map<string, ProviderCharge>();
  private sequence = 0;

  constructor(paymentEnv: string) {
    if (paymentEnv === "production") {
      throw new AppError(
        "SANDBOX_FORBIDDEN",
        "The sandbox provider cannot run when PAYMENT_ENV is production.",
        500,
      );
    }
  }

  async authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    if (input.signal === "cancel") {
      return { outcome: "cancelled" };
    }
    if (input.signal === "decline") {
      return { outcome: "declined", reference: this.nextRef(), reason: "Declined by sandbox issuer." };
    }
    if (input.signal === "timeout") {
      return { outcome: "timeout" };
    }
    if (input.signal === "provider_failure") {
      return {
        outcome: "provider_failure",
        reference: this.nextRef(),
        reason: "Sandbox provider unavailable.",
      };
    }
    if (input.signal === "network_error") {
      const reference = this.nextRef();
      this.charges.set(reference, {
        reference,
        amount: input.amount,
        currency: input.currency,
        status: "success",
        transactionId: input.transactionId,
        refundedAmount: 0,
      });
      return { outcome: "transport_error", reference, charged: true };
    }
    const reference = this.nextRef();
    return {
      outcome: "authorized",
      reference,
      authorizationCode: `SBX${reference.slice(-6)}`,
    };
  }

  async capture(input: CaptureInput): Promise<CaptureResult> {
    this.charges.set(input.reference, {
      reference: input.reference,
      amount: input.amount,
      currency: input.currency,
      status: "success",
      transactionId: input.transactionId,
      refundedAmount: 0,
    });
    return { outcome: "captured", reference: input.reference };
  }

  async voidAuthorization(reference: string): Promise<void> {
    const charge = this.charges.get(reference);
    if (charge && charge.refundedAmount === 0 && charge.status === "success") {
      this.charges.delete(reference);
    }
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const charge = this.charges.get(input.reference);
    if (!charge) {
      return { outcome: "failed", reason: "Sandbox has no charge for this reference." };
    }
    const refundedAmount = charge.refundedAmount + input.amount;
    const providerStatus = input.remainingAfter === 0 ? "refunded" : "partially_refunded";
    this.charges.set(input.reference, {
      ...charge,
      refundedAmount,
      status: providerStatus,
    });
    return { outcome: "refunded", reference: `RFN-${input.reference}`, providerStatus };
  }

  async getStatus(reference: string): Promise<ProviderStatus | null> {
    const charge = this.charges.get(reference);
    if (!charge) return null;
    return {
      reference: charge.reference,
      amount: charge.amount,
      currency: charge.currency,
      status: charge.status,
      refundedAmount: charge.refundedAmount,
    };
  }

  listCharges(): ProviderCharge[] {
    return [...this.charges.values()];
  }

  /** Test hook: a provider-side charge Red Face never created. */
  injectOrphan(amount: number, currency: string): ProviderCharge {
    const reference = this.nextRef();
    const charge: ProviderCharge = {
      reference,
      amount,
      currency,
      status: "success",
      transactionId: null,
      refundedAmount: 0,
    };
    this.charges.set(reference, charge);
    return charge;
  }

  private nextRef(): string {
    this.sequence += 1;
    return `SBX-${String(this.sequence).padStart(6, "0")}`;
  }
}
