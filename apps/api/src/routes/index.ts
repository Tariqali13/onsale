import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAccess, type Services } from '../app.js';
import { AppError } from '../lib/errors.js';
import { WaitingRoom } from '../queue/waitingRoom.js';
import { allInPrice } from '../checkout/pricing.js';
import { checkout } from '../checkout/checkout.js';
import { resetEvent } from '../events/reset.js';

const EventParams = z.object({ eventId: z.uuid() });
const ErrorBody = z.object({ error: z.object({ code: z.string(), message: z.string() }).passthrough() });

export async function registerRoutes(fastify: FastifyInstance, s: Services) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const guard = requireAccess(s);

  app.get('/health', { schema: { hide: true } }, async () => {
    const [db, redis] = await Promise.allSettled([s.db.query('SELECT 1'), s.redis.ping()]);
    const ok = db.status === 'fulfilled' && redis.status === 'fulfilled';
    return { ok, db: db.status === 'fulfilled', redis: redis.status === 'fulfilled' };
  });

  app.get('/metrics', { schema: { hide: true }, config: { rateLimit: false } }, async (_req, reply) => {
    reply.header('content-type', s.metrics.registry.contentType);
    return s.metrics.registry.metrics();
  });

  app.get(
    '/events/:eventId',
    {
      schema: {
        tags: ['events'],
        summary: 'Get an event by id or slug, including its seat-map layout',
        params: z.object({ eventId: z.string().min(1).max(80) }),
      },
    },
    async (req) => s.events.get(req.params.eventId),
  );

  app.get(
    '/events/:eventId/seats',
    {
      schema: {
        tags: ['events'],
        summary: 'Live seat availability (one Redis round trip, no DB query)',
        params: EventParams,
        querystring: z.object({ session: z.string().max(64).optional() }),
      },
    },
    async (req) => {
      const { eventId } = req.params;
      const { seats } = await s.events.seats(eventId);
      const states = await s.holds.states(eventId, seats.map((x) => x.id), req.query.session);
      return {
        seats: seats.map((seat) => ({
          id: seat.id,
          section: seat.section,
          row: seat.row,
          number: seat.number,
          priceCents: allInPrice(seat.priceCents),
          state: states.get(seat.id)!,
        })),
        generatedAt: Date.now(),
      };
    },
  );

  // ---- Waiting room -------------------------------------------------------

  app.post(
    '/events/:eventId/queue',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['queue'],
        summary: 'Join (or rejoin) the waiting room. Idempotent per session.',
        params: EventParams,
        body: z.object({ sessionId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/).optional() }).default({}),
      },
    },
    async (req) => {
      const { eventId } = req.params;
      await s.events.get(eventId); // 404 for unknown events
      const sessionId = req.body.sessionId ?? WaitingRoom.newSessionId();
      const result = await s.room.join(eventId, sessionId);
      if (result === 'joined') s.metrics.queueJoins.inc();
      return { sessionId, ...(await s.room.status(eventId, sessionId)) };
    },
  );

  app.get(
    '/events/:eventId/queue/:sessionId',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        tags: ['queue'],
        summary: 'Poll queue position. Returns an access pass once admitted.',
        params: EventParams.extend({ sessionId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) }),
      },
    },
    async (req) => {
      const { eventId, sessionId } = req.params;
      const status = await s.room.status(eventId, sessionId);
      if (status.state !== 'admitted') return status;
      const accessToken = await s.tokens.issue({ session: sessionId, eventId }, status.expiresAt);
      return { ...status, accessToken };
    },
  );

  // ---- Cart (seat holds) --------------------------------------------------

  app.put(
    '/events/:eventId/cart',
    {
      preHandler: guard,
      schema: {
        tags: ['cart'],
        summary: 'Atomically hold exactly these seats (all-or-nothing). Replaces any previous hold.',
        security: [{ accessPass: [] }],
        params: EventParams,
        body: z.object({ seatIds: z.array(z.uuid()).max(s.config.MAX_SEATS_PER_SESSION) }),
        response: {
          200: z.object({ seatIds: z.array(z.string()), expiresAt: z.number() }),
          409: ErrorBody,
        },
      },
    },
    async (req, reply) => {
      const { eventId } = req.params;
      const { byId } = await s.events.seats(eventId);
      const unknown = req.body.seatIds.find((id) => !byId.has(id));
      if (unknown) throw new AppError(400, 'invalid_seats', `Seat ${unknown} does not belong to this event`);

      const result = await s.holds.hold(eventId, req.access!.session, req.body.seatIds);
      s.metrics.holdAttempts.inc({ result: result.ok ? 'ok' : result.reason });
      if (!result.ok) {
        return reply.status(409).send({
          error: {
            code: result.reason === 'sold' ? 'seat_sold' : 'seat_held',
            message: result.reason === 'sold' ? 'That seat has just sold.' : 'Someone else is holding that seat right now.',
            seatId: result.seatId,
          },
        });
      }
      return { seatIds: result.seatIds, expiresAt: result.expiresAt };
    },
  );

  app.get(
    '/events/:eventId/cart',
    { preHandler: guard, schema: { tags: ['cart'], security: [{ accessPass: [] }], params: EventParams } },
    async (req) => s.holds.cart(req.params.eventId, req.access!.session),
  );

  app.delete(
    '/events/:eventId/cart',
    { preHandler: guard, schema: { tags: ['cart'], security: [{ accessPass: [] }], params: EventParams } },
    async (req) => ({ released: await s.holds.release(req.params.eventId, req.access!.session) }),
  );

  // ---- Checkout -----------------------------------------------------------

  app.post(
    '/events/:eventId/checkout',
    {
      preHandler: guard,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['checkout'],
        summary: 'Pay for held seats. Requires an Idempotency-Key header; retries are safe.',
        security: [{ accessPass: [] }],
        params: EventParams,
        headers: z.object({ 'idempotency-key': z.string().min(8).max(100) }).passthrough(),
        body: z.object({
          seatIds: z.array(z.uuid()).min(1).max(s.config.MAX_SEATS_PER_SESSION),
          paymentMethod: z.enum(['pm_card_visa', 'pm_card_chargeDeclined', 'pm_card_visa_slow']),
        }),
      },
    },
    async (req, reply) => {
      const result = await checkout(s, {
        eventId: req.params.eventId,
        session: req.access!.session,
        idempotencyKey: req.headers['idempotency-key'],
        seatIds: req.body.seatIds,
        paymentMethod: req.body.paymentMethod,
      });
      return reply.status(result.statusCode).send(result.body);
    },
  );

  // ---- Ops & demo ---------------------------------------------------------

  app.get(
    '/events/:eventId/stats',
    { schema: { tags: ['ops'], summary: 'Live onsale telemetry for the ops dashboard', params: EventParams } },
    async (req) => {
      const { eventId } = req.params;
      const { seats } = await s.events.seats(eventId);
      const [queue, sales, states] = await Promise.all([
        s.room.snapshot(eventId),
        s.events.salesSummary(eventId),
        s.holds.states(eventId, seats.map((x) => x.id)),
      ]);
      let held = 0;
      for (const st of states.values()) if (st === 'held') held++;
      return {
        queue,
        sales: { ...sales, capacity: seats.length, held },
        simulator: { activeBots: s.simulator.activeBots, enabled: s.config.ENABLE_SIMULATOR },
        generatedAt: Date.now(),
      };
    },
  );

  app.post(
    '/events/:eventId/simulate',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        tags: ['ops'],
        summary: 'Release a synthetic crowd into the onsale (demo deployments only)',
        params: EventParams,
        body: z.object({ bots: z.number().int().min(1).max(2000) }),
      },
    },
    async (req) => {
      if (!s.config.ENABLE_SIMULATOR) throw new AppError(403, 'simulator_disabled', 'The simulator is disabled here.');
      await s.events.get(req.params.eventId);
      const spawned = await s.simulator.spawn(req.params.eventId, req.body.bots);
      return { spawned };
    },
  );

  app.post(
    '/events/:eventId/reset',
    {
      config: { rateLimit: { max: 3, timeWindow: '1 minute' } },
      schema: {
        tags: ['ops'],
        summary: 'Reset the demo onsale. Admin token required unless the event is ≥ 90% sold.',
        params: EventParams,
      },
    },
    async (req) => {
      const { eventId } = req.params;
      const isAdmin = !!s.config.ADMIN_TOKEN && req.headers.authorization === `Bearer ${s.config.ADMIN_TOKEN}`;
      if (!isAdmin) {
        const { seats } = await s.events.seats(eventId);
        const { ticketsSold } = await s.events.salesSummary(eventId);
        if (ticketsSold < seats.length * 0.9) {
          throw new AppError(403, 'reset_not_allowed', 'The demo can be reset once it is at least 90% sold.');
        }
      }
      s.simulator.clear(eventId);
      await resetEvent(s, eventId);
      return { ok: true };
    },
  );
}
