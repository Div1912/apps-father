import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "../db";

/**
 * Write one row to the balance_ledger table.
 *
 * Always uses the root `prisma` instance (never a transaction client) so that
 * a failed ledger write can never abort the caller's main balance transaction.
 * Ledger writes are best-effort: failures are logged but never propagated.
 *
 * amount > 0 = credited to user, amount < 0 = debited from user.
 *
 * Source vocabulary:
 *   payment | agent_usage | refund | admin_grant | referral_bonus |
 *   first_deposit_bonus | sub_bonus | task | cashback |
 *   ton_topup | swap_buy | swap_sell
 */
export async function writeLedger(
  userId: number,
  currency: string,
  amount: number | bigint | Decimal,
  source: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  try {
    const amountDecimal =
      typeof amount === "bigint"
        ? new Decimal(amount.toString())
        : typeof amount === "number"
        ? new Decimal(amount.toFixed(9))
        : amount;

    await prisma.balanceLedger.create({
      data: {
        userId,
        currency,
        amount: amountDecimal,
        source,
        meta: meta ? (meta as any) : undefined,
      },
    });
  } catch (err) {
    // Ledger writes must never crash the calling code — log and continue.
    console.error("[Ledger] Failed to write ledger row:", err);
  }
}
