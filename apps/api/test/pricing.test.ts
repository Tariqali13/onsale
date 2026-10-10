import { describe, expect, it } from 'vitest';
import { allInPrice, feeFor, priceSeats } from '../src/checkout/pricing.js';

describe('pricing', () => {
  it('adds a 12% service fee plus a flat facility fee per ticket', () => {
    expect(feeFor(10000)).toBe(1200 + 250);
  });

  it('rounds half up on fractional cents', () => {
    // 12% of 12345 = 1481.4 → 1481; 12% of 12375 = 1485.0; 12% of 4 = 0.48 → 0
    expect(feeFor(12345)).toBe(1481 + 250);
    expect(feeFor(4)).toBe(0 + 250);
    // 12% of 2125 = 255.0, 12% of 2121 = 254.52 → 255
    expect(feeFor(2121)).toBe(255 + 250);
  });

  it('per-ticket all-in prices sum exactly to the order total', () => {
    const faces = [12900, 12900, 6900, 18900, 1];
    const { totalCents, subtotalCents, feesCents } = priceSeats(faces);
    expect(totalCents).toBe(faces.reduce((a, f) => a + allInPrice(f), 0));
    expect(subtotalCents + feesCents).toBe(totalCents);
  });

  it('rejects non-integer or negative amounts', () => {
    expect(() => priceSeats([10.5])).toThrow();
    expect(() => priceSeats([-1])).toThrow();
  });
});
