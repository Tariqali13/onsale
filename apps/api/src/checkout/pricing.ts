/**
 * All-in pricing: the price a buyer sees on the seat map already includes fees,
 * and the breakdown here must add up to it exactly. Integer cents only — never floats for money.
 */
export const SERVICE_FEE_BPS = 1200; // 12.00%
export const FACILITY_FEE_CENTS = 250; // per ticket

export interface PriceBreakdown {
  subtotalCents: number;
  feesCents: number;
  totalCents: number;
}

export function priceSeats(faceValuesCents: number[]): PriceBreakdown {
  if (faceValuesCents.some((v) => !Number.isInteger(v) || v < 0)) {
    throw new Error('Face values must be non-negative integer cents');
  }
  const subtotalCents = faceValuesCents.reduce((a, b) => a + b, 0);
  // Round half up per ticket so the per-ticket all-in price shown in the UI sums exactly to the total.
  const feesCents = faceValuesCents.reduce((acc, v) => acc + feeFor(v), 0);
  return { subtotalCents, feesCents, totalCents: subtotalCents + feesCents };
}

export function feeFor(faceValueCents: number): number {
  return Math.floor((faceValueCents * SERVICE_FEE_BPS + 5000) / 10000) + FACILITY_FEE_CENTS;
}

export function allInPrice(faceValueCents: number): number {
  return faceValueCents + feeFor(faceValueCents);
}
