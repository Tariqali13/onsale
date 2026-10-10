import Stripe from 'stripe';

export interface ChargeRequest {
  /** Our order id. Also used as the provider idempotency key, so a retried charge can never double-bill. */
  orderId: string;
  amountCents: number;
  currency: string;
  /** Opaque payment method reference from the client (a Stripe test PaymentMethod id, or a mock token). */
  paymentMethod: string;
}

export type ChargeResult =
  | { status: 'succeeded'; reference: string }
  | { status: 'declined'; reason: string };

export interface PaymentProvider {
  readonly name: string;
  charge(req: ChargeRequest): Promise<ChargeResult>;
  /** Used by the reconciler to settle orders whose outcome is unknown (e.g. process crashed mid-charge). */
  lookup(orderId: string): Promise<ChargeResult | null>;
}

/**
 * Deterministic provider for local dev, tests and the public demo.
 * Mirrors Stripe's test PaymentMethod ids so the frontend works with either provider:
 *   pm_card_visa                  → succeeds
 *   pm_card_chargeDeclined        → declined
 *   pm_card_visa_slow             → succeeds after a delay (exercise timeouts/UX)
 * No card numbers are ever collected.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';
  private readonly results = new Map<string, ChargeResult>();

  constructor(private readonly latencyMs = 150) {}

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    const prior = this.results.get(req.orderId);
    if (prior) return prior; // idempotent, like a real provider keyed on orderId
    await sleep(req.paymentMethod === 'pm_card_visa_slow' ? 2500 : this.latencyMs);
    const result: ChargeResult =
      req.paymentMethod === 'pm_card_chargeDeclined'
        ? { status: 'declined', reason: 'Your card was declined.' }
        : { status: 'succeeded', reference: `mock_pi_${req.orderId.slice(0, 8)}` };
    this.results.set(req.orderId, result);
    return result;
  }

  async lookup(orderId: string): Promise<ChargeResult | null> {
    return this.results.get(orderId) ?? null;
  }
}

/** Stripe PaymentIntents, test mode only (config refuses live keys). */
export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe';
  private readonly stripe: Stripe;

  constructor(secretKey: string) {
    this.stripe = new Stripe(secretKey);
  }

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    try {
      const pi = await this.stripe.paymentIntents.create(
        {
          amount: req.amountCents,
          currency: req.currency,
          payment_method: req.paymentMethod.replace(/_slow$/, ''),
          confirm: true,
          automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
          metadata: { orderId: req.orderId },
        },
        { idempotencyKey: `order-${req.orderId}` },
      );
      return pi.status === 'succeeded'
        ? { status: 'succeeded', reference: pi.id }
        : { status: 'declined', reason: `Payment ${pi.status}` };
    } catch (err) {
      if (err instanceof Stripe.errors.StripeCardError) {
        return { status: 'declined', reason: err.message };
      }
      throw err; // network / 5xx: surface as unknown, reconciler will settle it
    }
  }

  async lookup(orderId: string): Promise<ChargeResult | null> {
    const res = await this.stripe.paymentIntents.search({ query: `metadata['orderId']:'${orderId}'` });
    const pi = res.data[0];
    if (!pi) return null;
    if (pi.status === 'succeeded') return { status: 'succeeded', reference: pi.id };
    if (pi.status === 'canceled' || pi.status === 'requires_payment_method') {
      return { status: 'declined', reason: pi.last_payment_error?.message ?? pi.status };
    }
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
